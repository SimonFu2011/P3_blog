#Requires -Version 5.1
<#
.SYNOPSIS
  把 P3_blog 部署到 simonfu.xin（宝塔面板服务器），把能自动化的部分一次跑完。

.DESCRIPTION
  这个脚本只做三件"从你这台 Windows 机器能做到"的事：
    1. 预检：DNS、80/443 是否就绪，SSH 是否通 —— 明确告诉你是哪一步没做
    2. 推送：把 deploy/ 部署脚本推到 GitHub（服务器要从那里 clone）
    3. 引导：SSH 到服务器执行 blog-bootstrap-bt.sh
    4. 验证：检查公网站点，特别是 /admin/ 必须 404

  **脚本不会、也无法替你做**（只能在浏览器里点）：
    · 在 DNS 服务商加 A 记录
    · 在云厂商控制台放行 80/443
    · 在宝塔面板建站（纯静态）+ 申请 SSL

  脚本不保存、不询问任何密码：SSH 认证由 ssh 自己交互或走你的密钥。

.EXAMPLE
  # 默认：只做预检 + 验证（只读，安全）
  pwsh -File deploy\deploy-from-windows.ps1

.EXAMPLE
  # 全流程（前置条件都就绪之后）
  pwsh -File deploy\deploy-from-windows.ps1 -All
#>
[CmdletBinding()]
param(
    [string] $Domain     = 'simonfu.xin',
    [string] $ServerIp   = '43.108.100.116',
    [string] $SshUser    = 'root',
    [string] $DeployUser = 'blog',
    [int]    $SshPort    = 22,
    [string] $RepoDir    = (Split-Path -Parent $PSScriptRoot),

    [switch] $Preflight,      # 预检 DNS / 端口 / SSH
    [switch] $PushDeploy,     # 提交并推送 deploy/ 与 .gitattributes
    [switch] $Bootstrap,      # SSH 到服务器跑引导脚本
    [switch] $Verify,         # 校验公网站点
    [switch] $All,            # 以上全部
    [switch] $IpOnly,         # 先用 IP 上线：跳过 DNS 检查，站点名/校验都用 IP
    [switch] $Force           # 预检不过也继续（危险）
)

$ErrorActionPreference = 'Continue'

# 先用 IP 上线时，宝塔站点的主域名就是那个 IP（决定站点根目录与伪静态文件名）
$SiteName = if ($IpOnly) { $ServerIp } else { $Domain }
# 校验用的访问前缀
$BaseUrl  = if ($IpOnly) { "http://$ServerIp" } else { "https://$Domain" }

# ------------------------------------------------------------
# 输出小工具
# ------------------------------------------------------------
function Write-Step { param([string]$Text) Write-Host "`n=== $Text ===" -ForegroundColor Cyan }
function Write-Ok   { param([string]$Text) Write-Host "  [OK]   $Text" -ForegroundColor Green }
function Write-Bad  { param([string]$Text) Write-Host "  [FAIL] $Text" -ForegroundColor Red }
function Write-Warn { param([string]$Text) Write-Host "  [WARN] $Text" -ForegroundColor Yellow }
function Write-Info { param([string]$Text) Write-Host "         $Text" -ForegroundColor DarkGray }

# ------------------------------------------------------------
# 探测函数
# ------------------------------------------------------------
function Resolve-A {
    param([string]$Name)
    try {
        $r = Resolve-DnsName $Name -Type A -Server 8.8.8.8 -QuickTimeout -ErrorAction Stop
        $ips = @($r | Where-Object { $_.IPAddress } | Select-Object -ExpandProperty IPAddress)
        return $ips
    } catch { return @() }
}

function Test-Tcp {
    param([string]$Target, [int]$Port, [int]$TimeoutMs = 5000)
    $c = New-Object System.Net.Sockets.TcpClient
    try {
        $ok = $c.ConnectAsync($Target, $Port).Wait($TimeoutMs)
        return [bool]($ok -and $c.Connected)
    } catch { return $false }
    finally { $c.Dispose() }
}

function Get-HttpCode {
    param([string]$Url, [int]$TimeoutSec = 15)
    $code = & curl.exe -s -o NUL -m $TimeoutSec -w '%{http_code}' -I $Url 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $code) { return 'ERR' }
    return ([string]$code).Trim()
}

function Get-OriginUrl {
    $u = & git -C $RepoDir remote get-url origin 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $u) { return $null }
    return ([string]$u).Trim()
}

# ------------------------------------------------------------
# 1) 预检
# ------------------------------------------------------------
function Invoke-Preflight {
    Write-Step "预检：DNS 与端口（目标 $SiteName -> $ServerIp）"
    $pass = $true

    if ($IpOnly) {
        Write-Info "IP 优先模式：跳过 DNS 检查（域名 clientHold 与上线无关）"
    } else {
        foreach ($n in @($Domain, "www.$Domain")) {
            $ips = Resolve-A $n
            if ($ips.Count -eq 0) {
                Write-Bad "$n 没有任何 A 记录（NXDOMAIN）"
                $pass = $false
            } elseif ($ips -contains $ServerIp) {
                Write-Ok "$n -> $($ips -join ', ')"
            } else {
                Write-Bad "$n -> $($ips -join ', ')（不是 $ServerIp）"
                $pass = $false
            }
        }
    }

    # 80 是硬要求；443 在 IP 优先模式下只是"以后要开"，不算失败
    if (Test-Tcp -Target $ServerIp -Port 80) { Write-Ok "TCP 80 可达" }
    else { Write-Bad "TCP 80 不可达"; $pass = $false }

    if (Test-Tcp -Target $ServerIp -Port 443) { Write-Ok "TCP 443 可达" }
    elseif ($IpOnly) { Write-Warn "TCP 443 不可达 —— 用 IP 上线用不到 HTTPS，可以先不管" }
    else { Write-Bad "TCP 443 不可达"; $pass = $false }

    if (Test-Tcp -Target $ServerIp -Port $SshPort) { Write-Ok "TCP $SshPort（SSH）可达" }
    else { Write-Warn "TCP $SshPort（SSH）不可达 —— 若安全组只允许你自己的 IP，这是正常的" }

    # 本机公钥能不能免密登上服务器（决定后续步骤是否需要你手输密码）
    $keyOk = $false
    try {
        $probe = & ssh -o BatchMode=yes -o ConnectTimeout=8 "$SshUser@$ServerIp" "echo KEY_OK" 2>$null
        $keyOk = ($probe -join '') -match 'KEY_OK'
    } catch { $keyOk = $false }
    if ($keyOk) { Write-Ok "SSH 免密登录可用（$SshUser@$ServerIp）" }
    else {
        Write-Warn "SSH 免密登录不可用 —— 引导步骤会提示你输一次密码"
        Write-Info "想免密就先装公钥（见 deploy\DEPLOY-BT.md）"
    }

    if (-not $pass) {
        Write-Host ""
        Write-Host "  预检未通过。这些事只能在浏览器里做，做完再重跑：" -ForegroundColor Yellow
        $n = 0
        if (-not $IpOnly) {
            $n++
            Write-Host "   $n) DNS：在域名解析处加两条 A 记录" -ForegroundColor Yellow
            Write-Host "        @    -> $ServerIp" -ForegroundColor Yellow
            Write-Host "        www  -> $ServerIp" -ForegroundColor Yellow
            Write-Host "      验证：Resolve-DnsName $Domain -Type A -Server 8.8.8.8" -ForegroundColor Yellow
            Write-Host "      提示：域名若处于 clientHold（实名认证未完成），加记录也不生效；" -ForegroundColor DarkYellow
            Write-Host "            可以先用 -IpOnly 跳过 DNS，直接把站点跑起来。" -ForegroundColor DarkYellow
        }
        $n++
        Write-Host "   $n) 云厂商安全组：入方向放行 TCP 80（要 HTTPS 再加 443）" -ForegroundColor Yellow
        $n++
        Write-Host "   $n) 宝塔面板：网站 -> 添加站点，域名填 $SiteName" -ForegroundColor Yellow
        Write-Host "      （根目录会是 /www/wwwroot/$SiteName）" -ForegroundColor Yellow
        Write-Host "      PHP 版本选「纯静态」，不建数据库/FTP" -ForegroundColor Yellow
        Write-Host ""
        Write-Host "  详细步骤见 deploy\DEPLOY-BT.md" -ForegroundColor DarkGray
    }
    return $pass
}

# ------------------------------------------------------------
# 2) 推送部署脚本
# ------------------------------------------------------------
function Invoke-PushDeploy {
    Write-Step "推送 deploy/ 到 GitHub（服务器要从那里 clone）"

    if (-not (Test-Path (Join-Path $RepoDir '.git'))) {
        Write-Bad "$RepoDir 不是 git 仓库"; return $false
    }
    $origin = Get-OriginUrl
    if (-not $origin) { Write-Bad "拿不到 origin 地址"; return $false }
    Write-Info "origin = $origin"

    # 提醒：真正上线的是 main 上的内容
    $ahead = @(& git -C $RepoDir log --oneline 'origin/main..main' 2>$null)
    if ($ahead.Count -gt 0) {
        Write-Warn "本地有 $($ahead.Count) 个已提交但未推送的提交，push 后会一起上线："
        $ahead | ForEach-Object { Write-Info "  $_" }
    }
    $dirty = @(& git -C $RepoDir status --short 2>$null | Where-Object { $_ -match '^ ?M' })
    if ($dirty.Count -gt 0) {
        Write-Warn "另有 $($dirty.Count) 个已修改但**未提交**的文件，本次不会被推送："
        $dirty | ForEach-Object { Write-Info "  $($_.Trim())" }
        Write-Info "（要一起上线就先自己 git add/commit）"
    }

    & git -C $RepoDir add -- deploy .gitattributes
    if ($LASTEXITCODE -ne 0) { Write-Bad "git add 失败"; return $false }

    $staged = @(& git -C $RepoDir diff --cached --name-only 2>$null)
    if ($staged.Count -gt 0) {
        Write-Info "将提交：$($staged -join ', ')"
        & git -C $RepoDir commit -m 'chore(deploy): 加入云服务器部署脚本与配置' | Out-Null
        if ($LASTEXITCODE -ne 0) { Write-Bad "git commit 失败"; return $false }
        Write-Ok "已提交"
    } else {
        Write-Info "deploy/ 没有新改动，跳过提交"
    }

    & git -C $RepoDir push origin main
    if ($LASTEXITCODE -ne 0) {
        Write-Bad "git push 失败（私有仓库需要先登录/配凭据）"
        return $false
    }
    Write-Ok "已推送到 origin/main"
    Write-Info "服务器现在可以 clone 到 deploy/ 里的引导脚本了"
    return $true
}

# ------------------------------------------------------------
# 3) 在服务器上执行引导脚本
# ------------------------------------------------------------
function Invoke-Bootstrap {
    Write-Step "SSH 到 $SshUser@$ServerIp 执行引导脚本"
    $origin = Get-OriginUrl
    $remote = @"
set -e
mkdir -p /srv/blog
if [ ! -d /srv/blog/repo/.git ]; then
  git clone $origin /srv/blog/repo
else
  # 服务器仓库要跟远端对齐，否则会拿旧版脚本跑
  git -C /srv/blog/repo fetch --prune origin
  git -C /srv/blog/repo reset --hard origin/main
fi
# 语法门检：这个脚本会以 root 运行，先确认文件本身没问题
bash -n /srv/blog/repo/deploy/bin/blog-bootstrap-bt.sh
DOMAIN=$SiteName bash /srv/blog/repo/deploy/bin/blog-bootstrap-bt.sh
"@
    Write-Info "远程命令："
    $remote -split "`n" | ForEach-Object { Write-Info "  $_" }
    Write-Host ""

    & ssh -p $SshPort -o ConnectTimeout=15 "$SshUser@$ServerIp" $remote
    if ($LASTEXITCODE -ne 0) {
        Write-Bad "远程执行失败（退出码 $LASTEXITCODE）"
        Write-Info "常见原因：SSH 密码/密钥不对；宝塔站点还没建（脚本会提示）"
        return $false
    }
    Write-Ok "服务器侧引导完成"
    return $true
}

# ------------------------------------------------------------
# 4) 验证公网站点
# ------------------------------------------------------------
function Invoke-Verify {
    Write-Step "验证 $BaseUrl"

    $checks = @(
        @{ Url = "$BaseUrl/";                           Expect = @('200');        Desc = '首页' },
        @{ Url = "$BaseUrl/archive.html";               Expect = @('200');        Desc = '归档页' },
        @{ Url = "$BaseUrl/about.html";                 Expect = @('200');        Desc = '关于页' },
        @{ Url = "$BaseUrl/404.html";                   Expect = @('200');        Desc = '404 页本身可访问' },
        @{ Url = "$BaseUrl/admin/";                     Expect = @('404');        Desc = '管理页必须不可达' },
        @{ Url = "$BaseUrl/server/dev-server.mjs";      Expect = @('404');        Desc = '本地服务代码必须不可达' },
        @{ Url = "$BaseUrl/no-such-page-xyz";           Expect = @('404');        Desc = '不存在的地址应返回 404' }
    )
    if (-not $IpOnly) {
        $checks += @{ Url = "http://$Domain/"; Expect = @('301','302'); Desc = 'HTTP 跳 HTTPS' }
    }

    $bad = 0
    foreach ($c in $checks) {
        $code = Get-HttpCode $c.Url
        $ok = $c.Expect -contains $code
        if (-not $ok) { $bad++ }
        $label = if ($ok) { 'OK  ' } else { 'FAIL' }
        $line = "  [{0}] {1,-6} {2}  ({3})" -f $label, $code, $c.Url, $c.Desc
        if ($ok) { Write-Host $line -ForegroundColor Green } else { Write-Host $line -ForegroundColor Red }
    }
    if ($bad -eq 0) {
        Write-Ok "全部通过"
    } else {
        Write-Warn "$bad 项不符合预期"
        if (-not $IpOnly) { Write-Info "https 全 ERR -> 证书还没签（宝塔：网站 -> SSL -> Let's Encrypt）" }
        Write-Info "/admin/ 或 /server/ 返回 200 -> 伪静态规则没生效，检查 deploy\DEPLOY-BT.md 第 3 步"
    }
    return ($bad -eq 0)
}

# ------------------------------------------------------------
# 主流程
# ------------------------------------------------------------
if ($All) { $Preflight = $true; $PushDeploy = $true; $Bootstrap = $true; $Verify = $true }
if (-not ($Preflight -or $PushDeploy -or $Bootstrap -or $Verify)) { $Preflight = $true; $Verify = $true }

Write-Host ""
Write-Host "P3_blog 部署助手  |  $SiteName -> $ServerIp  |  仓库 $RepoDir" -ForegroundColor White
if ($IpOnly) { Write-Host "IP 优先模式：站点先用 http://$ServerIp/ 上线，域名就绪后再切" -ForegroundColor DarkGray }

$ok = $true
if ($Preflight) {
    $ok = Invoke-Preflight
    if (-not $ok -and -not $Force) {
        Write-Host "`n预检未通过，已停止（加 -Force 可强行继续，但后面的步骤大概率也会失败）。" -ForegroundColor Yellow
        exit 1
    }
}

if ($PushDeploy) {
    if (-not (Invoke-PushDeploy)) { exit 1 }
}

if ($Bootstrap) {
    if (-not (Invoke-Bootstrap)) { exit 1 }
}

if ($Verify) {
    Invoke-Verify | Out-Null
}

Write-Host "`n完成。日常发布：git push origin main; ssh $DeployUser@$ServerIp blog-publish" -ForegroundColor Cyan
if ($IpOnly) {
    Write-Host "域名就绪后（实名认证通过 + A 记录生效）：" -ForegroundColor Cyan
    Write-Host "  1) 面板 → 网站 → $SiteName → 设置，把 $Domain 和 www.$Domain 加进域名列表" -ForegroundColor Cyan
    Write-Host "  2) 面板 → SSL → Let's Encrypt → 申请 → 强制 HTTPS（无需重新发布）" -ForegroundColor Cyan
}
