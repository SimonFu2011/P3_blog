-- ============================================================================
-- P3_blog 用户 / 会话 / 评论系统 —— MySQL 5.7 库表结构 DDL
-- 文件: blog-enter/server/sql/schema.sql
-- 角色: 本文件是后端 T1(Node 服务) / T3(登录注册) / T5(评论) 的唯一列名契约，
--       任何一方要改列名必须改这里并同步通知，不要在代码里另起名字。
-- ============================================================================
--
-- 一、目标环境
--   * MySQL 5.7.x（sql_mode = NO_ENGINE_SUBSTITUTION,STRICT_TRANS_TABLES）
--   * 库名 p3blog，字符集 utf8mb4 / 排序规则 utf8mb4_unicode_ci（中文与 emoji 都能存）
--   * 引擎 InnoDB（需要真实外键与行级锁；MyISAM 不支持外键）
--   * 执行方式：mysql --default-character-set=utf8mb4 -uroot -p < schema.sql
--     文件开头已 SET NAMES utf8mb4，保证下面的中文注释/中文表注释按 utf8mb4 落库。
--
-- 二、不使用任何 MySQL 8 专属语法（5.7 必须能一次跑通）
--   * 不做表级校验约束（5.7 只解析不生效，语义落空还会给后来人错觉，
--     业务规则一律在应用层用显式校验 + 参数化 SQL 表达）
--   * 不用函数/表达式作为列默认值（默认值只用常量）、不用函数索引、不用不可见索引、
--     不用降序索引、不用 MySQL 8 的 0900 系排序规则、不用窗口函数与 CTE
--   * 时间列一律用 CURRENT_TIMESTAMP 字面默认值（5.6+ 已支持多个 TIMESTAMP 列带默认值）
--
-- 三、重复执行策略：选“非破坏式幂等”（建表带 IF NOT EXISTS），不选先删后建
--   * 理由：schema.sql 会被部署脚本反复执行（首次装机、迁移、排障重跑）。
--     先删后建在第二次执行时会清空线上用户与评论数据，代价远大于收益；
--     带 IF NOT EXISTS 的建表对空库一次执行成功，对已有库重复执行零副作用。
--   * 代价与纪律：IF NOT EXISTS 不会修改已存在表的结构。后面对表的任何变更必须新增
--     独立的 ALTER TABLE 迁移脚本（例如 sql/migrations/0002-xxx.sql），
--     禁止改完本文件里的历史列定义就重跑——那样只会让线上库与实际结构悄悄偏离。
--   * 如需彻底重建（仅限本地开发机，线上禁止）：由运维手工删掉 p3blog 库（该动作不在本
--     文件里，避免误执行），再重跑本文件。
--
-- 四、外键关系（应用层不需要再手工级联清理）
--   comments.user_id     -> users.id      ON DELETE CASCADE   评论 → 用户
--   comments.parent_id   -> comments.id   ON DELETE CASCADE   评论 → 评论（楼中楼自引用）
--   sessions.user_id     -> users.id      ON DELETE CASCADE   会话 → 用户
--   email_verify.user_id -> users.id      ON DELETE CASCADE
--   auth_throttle / auth_log 有意不加外键：限流与审计要保留 IP 维度的记录，
--   不能因为用户被删除就把攻击痕迹一起级联删掉（auth_log.user_id 允许 NULL）。
--
-- 五、配套文件
--   blog-enter/server/sql/grant-app-user.sql 负责建应用账号 'p3app'@'127.0.0.1'
--   并只授予 p3blog.* 的 SELECT/INSERT/UPDATE/DELETE；应用连接参数由部署阶段的
--   /etc/p3blog/public.env（P3_DB_HOST/P3_DB_PORT/P3_DB_NAME/P3_DB_USER/P3_DB_PASSWORD）提供。
--
-- 六、列约束取舍说明
--   * username / email / password_hash 加了 NOT NULL：列名与契约一致，只是在契约给定的
--     列上补了非空约束，避免出现“有行无用户名”的脏数据（严格模式下插入 NULL 会直接报错）。
--   * 其余列的类型、默认值、可空性、索引均按契约写死，未做任何增删改名。
-- ============================================================================

SET NAMES utf8mb4;

CREATE DATABASE IF NOT EXISTS `p3blog`
  DEFAULT CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE `p3blog`;

-- ----------------------------------------------------------------------------
-- users：用户账号表（公开注册用户与管理员共表，用 role 区分）
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `users` (
  `id` BIGINT NOT NULL AUTO_INCREMENT
    COMMENT '用户主键，自增。用 BIGINT 而不是 INT：用户量长期增长时不用做迁移式扩容',
  `username` VARCHAR(32) NOT NULL
    COMMENT '登录名，唯一。utf8mb4_unicode_ci 下比较大小写不敏感，"Alice" 与 "alice" 视为同一账号，避免仿冒式重名；32 字符足够且远小于索引上限',
  `email` VARCHAR(190) NOT NULL
    COMMENT '邮箱，唯一，也是找回口令的凭据。190 = 767 字节索引前缀上限 / utf8mb4 每字符 4 字节，兼容 InnoDB COMPACT 行格式，不用改 row_format 也能建唯一索引',
  `password_hash` VARCHAR(255) NOT NULL
    COMMENT '口令摘要，只存哈希、永不存明文。255 字节足以容纳 pbkdf2/argon2 的自描述编码串，老数据也能继续放下',
  `password_algo` VARCHAR(32) NOT NULL DEFAULT 'pbkdf2-sha256'
    COMMENT '摘要算法标识。单独存一列是为了日后无痛升级算法：登录时按该列选校验函数，验证通过且算法过旧就顺手重算回写',
  `avatar` VARCHAR(255) DEFAULT NULL
    COMMENT '头像地址，NULL 表示用前端默认头像。本轮不做上传，只留字段',
  `role` ENUM('user','admin') NOT NULL DEFAULT 'user'
    COMMENT '角色。只有两种取值，用 ENUM 而不是独立角色表：省一次 JOIN，也不会出现拼错的角色名',
  `email_verified` TINYINT(1) NOT NULL DEFAULT 0
    COMMENT '邮箱是否已验证（1 已验 / 0 未验）。本轮 SMTP 未配置，注册后一直为 0，验证流程只留可插拔骨架',
  `status` ENUM('active','disabled') NOT NULL DEFAULT 'active'
    COMMENT '账号状态。disabled 用于封禁：保留账号与其历史评论，和"删号"区分开（删号走 DELETE，评论按外键级联清理）',
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    COMMENT '注册时间，按数据库服务器时区记录，由 MySQL 自动填写',
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    COMMENT '资料最近变更时间，由 MySQL 自动维护，应用不用手写',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_users_username` (`username`),
  UNIQUE KEY `uk_users_email` (`email`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='用户账号表：公开注册用户与管理员共用，role 区分；只存口令哈希不存明文';

-- ----------------------------------------------------------------------------
-- sessions：登录会话表（一个用户可多端并存多条会话）
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `sessions` (
  `id` CHAR(64) NOT NULL
    COMMENT '会话标识 = 会话令牌的 SHA-256 十六进制摘要（固定 64 字符）。客户端 cookie 里拿的是原始随机令牌，库里只存摘要：即使库被拖走也无法直接拿去冒用会话。CHAR 定长免去长度字节，主键等值查找最快',
  `user_id` BIGINT NOT NULL
    COMMENT '会话所属用户，指向 users.id；删用户时会话一并级联撤销',
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    COMMENT '会话创建（登录成功）时间。登录成功后换发新 id 写入本表，便于审计"这个会话什么时候建立的"',
  `last_seen` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    COMMENT '最近一次带该会话访问的时间。由应用在请求时更新（滑动续期），用于判断会话是否还活跃；不设 ON UPDATE，避免任何 UPDATE 都改动它',
  `expires_at` DATETIME NOT NULL
    COMMENT '会话绝对过期时间。用 DATETIME 而不是 TIMESTAMP：TIMESTAMP 每次读写都按连接时区换算，换时区或跨时区部署后过期判断会漂移，DATETIME 是"写什么读什么"，比较稳定',
  `ip` VARCHAR(64) DEFAULT NULL
    COMMENT '建立会话时的来源 IP，64 字符可容下 IPv6 及带端口写法。只作安全审计线索，不作鉴权依据（IP 会变、可伪造）',
  `ua` VARCHAR(255) DEFAULT NULL
    COMMENT 'User-Agent 摘要，超长由应用层截断后写入，用于排查异常登录设备',
  PRIMARY KEY (`id`),
  KEY `idx_sessions_user` (`user_id`),
  KEY `idx_sessions_expires` (`expires_at`),
  CONSTRAINT `fk_sessions_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='登录会话表：一用户多会话；expires_at 支持过期清理，user_id 外键保证删用户即撤销全部会话';

-- ----------------------------------------------------------------------------
-- comments：文章评论表（楼中楼自引用 + 软删除）
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `comments` (
  `id` BIGINT NOT NULL AUTO_INCREMENT
    COMMENT '评论主键，自增；同时是 parent_id 的引用目标',
  `slug` VARCHAR(200) NOT NULL
    COMMENT '文章标识。用前端路由里的文章 slug（同一篇文章全站唯一且稳定），不存自增文章 id：静态站的文章来源是文件，slug 比 id 更抗重排',
  `user_id` BIGINT NOT NULL
    COMMENT '评论作者，指向 users.id。评论必须登录才能发，所以非空、且能级联清理',
  `parent_id` BIGINT DEFAULT NULL
    COMMENT '父评论 id，NULL 表示顶层评论。自引用外键实现一层/多层回复，删除父评论时子回复一并级联',
  `content` TEXT NOT NULL
    COMMENT '评论正文，纯文本存储（前端用 textContent 渲染，不做 HTML 解析）。TEXT 上限 64KB，长度上限由应用层卡在 1~2000 字符，比 VARCHAR 更少行长计算',
  `status` ENUM('approved','pending','deleted') NOT NULL DEFAULT 'approved'
    COMMENT '状态：approved 正常展示；pending 待审（敏感词/人工审核预留）；deleted 软删除。选软删而不是物理删：删掉行会让子回复的 parent_id 悬空、楼层断裂，也会让审计与误删恢复无从下手；软删只改状态，列表查询按 status 过滤即可',
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    COMMENT '发表时间，评论列表按它排序；与复合索引配合避免排序开销',
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    COMMENT '最后编辑时间；软删除也会刷新这一列，可据此做"刚删除几分钟内可撤销"的实现',
  PRIMARY KEY (`id`),
  KEY `idx_comments_slug_status_created` (`slug`,`status`,`created_at`),
  KEY `idx_comments_user` (`user_id`),
  KEY `idx_comments_parent` (`parent_id`),
  CONSTRAINT `fk_comments_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_comments_parent` FOREIGN KEY (`parent_id`) REFERENCES `comments` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='文章评论表：楼中楼（parent_id 自引用）+ 状态软删除；级联删除只在硬删（删用户/清库）时触发';

-- 为什么 slug 上要带 status 的复合索引 (slug, status, created_at)：
--   评论列表的查询固定是 WHERE slug = ? AND status = 'approved' ORDER BY created_at DESC。
--   左边两列做等值匹配，第三列 created_at 天然有序，因此一个索引就能同时完成"过滤 + 排序"，
--   可直接反向扫描取最近 N 条，避免 Using filesort（评论量大时这是最贵的一步）。
--   如果只建 (slug)，命中后仍需回表筛 status 并排序；若拆成 (slug) 与 (status) 两个单列索引，
--   优化器也只能用一个，排序依然要额外做。软删也让 status 成为高频过滤条件，
--   所以它值得进索引前缀，而不是留在回表条件里。
--   idx_comments_parent 是 parent_id 外键所需的索引（InnoDB 要求引用列有索引），
--   顺便服务"查某条评论的回复"和级联删除。

-- ----------------------------------------------------------------------------
-- auth_throttle：登录/注册等认证动作的限流计数表
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `auth_throttle` (
  `id` BIGINT NOT NULL AUTO_INCREMENT
    COMMENT '自增主键；业务唯一性由下面的 (ip, action) 唯一键保证',
  `ip` VARCHAR(64) NOT NULL
    COMMENT '来源 IP，取直连 socket 的对端地址。不直接信任可伪造的 X-Forwarded-For，除非确认请求一定经过自家反代（本项目 nginx 会覆盖该头）',
  `action` VARCHAR(32) NOT NULL
    COMMENT '动作维度，例如 login / register / reset。按动作分别计数，避免登录失败把注册正常流量一起熔断',
  `fails` INT NOT NULL DEFAULT 0
    COMMENT '连续失败计数。登录成功或窗口期过后由应用层清零；用 INT 而不是 TINYINT 是为了不必担心计数溢出',
  `gate_until` DATETIME DEFAULT NULL
    COMMENT '熔断截止时间，NULL 表示未熔断。用 DATETIME 便于与应用算出的本地时间直接比较，语义直观',
  `last_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    COMMENT '最近一次计数变更时间，自动维护；用于清理长期不活跃的限流行',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_auth_throttle_ip_action` (`ip`,`action`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='认证限流计数表：(ip,action) 唯一键让应用可用一条 INSERT ... ON DUPLICATE KEY UPDATE 原子累加，避免并发下读改写丢计数';

-- ----------------------------------------------------------------------------
-- email_verify：邮箱验证 / 重置口令令牌表（本轮建表备用，SMTP 未配置不接入发信）
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `email_verify` (
  `id` BIGINT NOT NULL AUTO_INCREMENT
    COMMENT '主键',
  `user_id` BIGINT NOT NULL
    COMMENT '令牌归属用户，指向 users.id，删用户即级联失效',
  `token` CHAR(64) NOT NULL
    COMMENT '一次性验证令牌，长度固定 64：与应用约定"只落库存 SHA-256 摘要、原始令牌只出现在邮件链接里"，与 sessions.id 同一套思路',
  `purpose` ENUM('register','reset') NOT NULL DEFAULT 'register'
    COMMENT '用途：register 注册激活 / reset 重置口令。分开存是为了日后能按流程分别失效与限流，不会拿注册令牌去重置口令',
  `expires_at` DATETIME NOT NULL
    COMMENT '令牌过期时间，校验时要求未过期',
  `used_at` DATETIME DEFAULT NULL
    COMMENT '核销时间，NULL 表示尚未使用；一次性令牌的校验条件是 used_at IS NULL AND expires_at > NOW()',
  PRIMARY KEY (`id`),
  KEY `idx_email_verify_token` (`token`),
  KEY `idx_email_verify_user` (`user_id`),
  CONSTRAINT `fk_email_verify_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='邮箱验证/重置口令令牌表：本轮 SMTP 未配置，仅建表备用，服务不接入发信';

-- idx_email_verify_user 除了按用户清理旧令牌，也是 user_id 外键必需的索引
-- （InnoDB 要求外键列上有索引，否则建表时自动隐式建一个同名索引，不如显式声明清楚）。
-- token 只建普通索引不建唯一索引：令牌本身应用层保证一次性，唯一约束帮不上忙，
-- 却会在"同一令牌并发写入"时报重复键错误，把并发问题变成写失败。

-- ----------------------------------------------------------------------------
-- auth_log：认证审计日志表（只追加，供安全排查）
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `auth_log` (
  `id` BIGINT NOT NULL AUTO_INCREMENT
    COMMENT '主键，追加顺序即事件顺序',
  `user_id` BIGINT DEFAULT NULL
    COMMENT '相关用户 id；登录失败、用户名不存在等场景无法确定用户，因此允许 NULL，也因此不加外键——审计要留住"有人拿已删账号在试"这类痕迹，不能被级联删除带走',
  `ip` VARCHAR(64) DEFAULT NULL
    COMMENT '来源 IP，口径与 auth_throttle.ip 一致；个别内部调用可能没有 IP，故可空',
  `action` VARCHAR(32) DEFAULT NULL
    COMMENT '动作标识：login / register / logout / reset 等，与 auth_throttle.action 用同一套取值便于对照',
  `ok` TINYINT(1) DEFAULT NULL
    COMMENT '结果：1 成功 / 0 失败',
  `detail` VARCHAR(255) DEFAULT NULL
    COMMENT '补充说明，例如失败分类或用户名（截断到 255）。这里只写排查用的最小信息：任何口令、令牌、摘要都不允许写入',
  `at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    COMMENT '事件发生时间，按天排查与按保留期清理都靠它',
  PRIMARY KEY (`id`),
  KEY `idx_auth_log_at` (`at`),
  KEY `idx_auth_log_user` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='认证审计日志表：只追加不修改，记录认证结果与来源 IP；user_id 不加外键以便长期保留痕迹';

-- ----------------------------------------------------------------------------
-- page_views：页面访问计数（首屏/内页那条"访问统计"的唯一数据来源）
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `page_views` (
  `id` BIGINT NOT NULL AUTO_INCREMENT
    COMMENT '自增主键，追加顺序即访问顺序',
  `day` DATE NOT NULL
    COMMENT '站点时区（+08:00）下的日期，由应用算好写入。刻意不用 CURDATE()：库或容器时区一变，"今日访问量"就会在半夜跳错一天，而这一列是它唯一的判据',
  `visitor` CHAR(32) NOT NULL
    COMMENT '访客标识 = HMAC-SHA256(盐, IP|UA) 的前 32 位十六进制。**不存 IP、也不存 UA**：IPv4 空间可枚举，所以裸哈希等于存了 IP，必须用带随机盐的 HMAC；盐在 page_meta，只存在于本机库',
  `path` VARCHAR(120) NOT NULL DEFAULT ''
    COMMENT '被访问的页面路径（取自同源 Referer 的 pathname），截断到 120、剔掉控制字符。取不到或不同源时为空串；**它是参考值**，客户端可不发或伪造，所以任何计数与判权都不许读它，只为"哪几篇受欢迎"服务',
  `at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    COMMENT '入库时间（库会话 time_zone=+00:00，即 UTC）。只用于人与运维看，不参与"今日"判定',
  PRIMARY KEY (`id`),
  KEY `idx_page_views_day` (`day`),
  KEY `idx_page_views_visitor` (`visitor`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='页面访问计数表：一行一次访问；访客标识是带盐 HMAC 的截断值，表里没有明文 IP';

-- 两条索引各自服务一个查询，都不能省：
--   idx_page_views_day     ：「今日访问量」是 day = ? 的等值/范围扫描，走它不必回表
--   idx_page_views_visitor  ：COUNT(DISTINCT visitor)（总访客数）靠它做索引扫描；
--                             没有它就是全表 + 临时表去重
-- 规模假设（为什么要在这里写下来）：个人博客量级，十万行时 COUNT(DISTINCT) 仍是毫秒级，
-- 所以本轮**不做**每日预聚合、也**不写**自动清理 —— "总访问量"一旦被清理就再也算不出来，
-- 而它恰恰是业主最在意的那个数。真到百万行级再另建每日去重表 + 计数器，
-- 那时也要保留本表：历史只能从这里重算。

-- ----------------------------------------------------------------------------
-- page_meta：杂项键值表（当前只放访问统计用的 HMAC 盐）
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `page_meta` (
  `k` VARCHAR(40) NOT NULL
    COMMENT '键名，例如 visitor_salt',
  `v` VARCHAR(200) NOT NULL
    COMMENT '值。当前只放 32 字节随机盐的十六进制表示（64 字符）',
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    COMMENT '最近修改时间，由 MySQL 自动维护',
  PRIMARY KEY (`k`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='杂项键值表：放"必须留在库里、不能进仓库也不能进配置文件"的小状态（当前是访问统计的盐）';

-- 为什么盐放在库里，而不是加一个配置文件 / 环境变量：
--   ① 进配置就多一个部署件和一条"文件必须存在"的 fail-fast 分支，而这份盐丢失
--      只影响"总访客数"（从那一刻重新计数），不值得为它增加启动约束；
--   ② 绝不进仓库：一份盐配所有部署，哈希表就变成跨站可对照；
--   ③ 它只在**首次写入访问记录时**惰性生成一次，之后常驻进程内存，
--      不会变成"每个请求多读一次库"。
-- 注意盐与 IP 是"一对"关系：轮换盐 = 之前的 visitor 值与之后的对不上，
-- 总访客数会从轮换那一刻重新开始累积（page_views 明细不动）。

-- ============================================================================
-- 自检（人工排障时手动执行，非部署必需；这里只作注释保留，不参与建表）
--   SHOW TABLES;                       -- 应看到 8 张表
--   SELECT table_name, engine, table_collation, table_comment
--     FROM information_schema.tables WHERE table_schema='p3blog';
--   SELECT table_name, constraint_name, referenced_table_name
--     FROM information_schema.key_column_usage
--    WHERE table_schema='p3blog' AND referenced_table_name IS NOT NULL;  -- 应见 3 类外键
-- ============================================================================
