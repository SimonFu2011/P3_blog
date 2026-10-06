-- ============================================================================
-- P3_blog 公开 Node 服务（回环 127.0.0.1:8850）使用的 MySQL 应用账号与授权
-- 文件: blog-enter/server/sql/grant-app-user.sql
-- 目标: MySQL 5.7.x，库 p3blog（结构与字符集见同目录 schema.sql）
-- 前置: 先执行 schema.sql 建库建表，再执行本文件
-- ============================================================================
--
-- 一、授权边界（最小权限）
--   * 账号：'p3app'@'127.0.0.1' —— 只允许从本机回环地址连入。
--     公开 Node 服务与 MySQL 同机部署、走 127.0.0.1，因此不需要也不允许更宽的来源
--     （不用 '%'，也不用 'localhost' 之外的别名）。这样即便 3306 误对公网暴露，
--     该账号也无法从外部登录。
--   * 权限：仅 p3blog 库上的 SELECT / INSERT / UPDATE / DELETE（四类 DML），一条授权语句给全。
--   * 明确不授予：建库建表改表等 DDL、用户与授权管理、读写服务器文件的 FILE，
--     以及任何 p3blog 之外的库或全局权限。应用只需要读写数据：即使被注入，
--     影响面也停在数据层，改不了结构、提不了权、读不到服务器上的文件。
--   * 应用侧只读的旁路需求（例如看表结构）不通过加权限解决，排障一律走 root，
--     避免"为了方便临时加权限"把最小权限边界磨掉。
--
-- 二、口令处理（仓库里不出现明文生产口令）
--   * 本文件不写死生产口令。默认值只是本地开发用的占位口令；部署时用会话变量覆盖：
--       Linux: printf "SET @p3app_pw='%s';\n" "$P3APP_DB_PASSWORD" | cat - grant-app-user.sql | mysql --default-character-set=utf8mb4 -uroot -p
--       （用 openssl rand -base64 24 生成随机口令；base64 不含单引号，可直接嵌入。）
--   * 直接执行本文件（不覆盖变量）时会落到下面的开发占位口令，脚本末尾会打印醒目提示；
--     上线前必须用上面的方式覆盖，并把同一口令写进 /etc/p3blog/public.env 的 P3_DB_PASSWORD。
--   * 若口令里出现单引号，本文件的拼接方式会被打断——请改用生成器产出不含引号的口令。
--
-- 三、可重复执行
--   * CREATE USER IF NOT EXISTS：账号已存在时不报错、也不覆盖已有口令（只给 warning），
--     所以重复执行本文件不会把口令重置回占位值；需要轮换口令时手工执行文末的 ALTER USER。
--   * 先建账号、再授权，且只有一条授权语句，重复执行结果一致（MySQL 授权是累积的，
--     但本文件从来没有授过别的权限，所以累积结果始终是这四类 DML）。
-- ============================================================================

SET NAMES utf8mb4;

-- 允许外部先 SET @p3app_pw='...' 覆盖；未设置时该变量为 NULL，于是落到本地开发占位口令。
SET @p3app_pw_override = @p3app_pw;
SET @p3app_pw = IFNULL(@p3app_pw, 'CHANGE_ME_dev_only_not_for_production');
SET @p3app_pw_is_default = (@p3app_pw_override IS NULL);

-- 用预处理语句拼出建号语句，避免把生产口令固化进文件
SET @create_user_sql = CONCAT(
  'CREATE USER IF NOT EXISTS ''p3app''@''127.0.0.1'' IDENTIFIED BY ''', @p3app_pw, ''''
);
PREPARE stmt_create_user FROM @create_user_sql;
EXECUTE stmt_create_user;
DEALLOCATE PREPARE stmt_create_user;

-- 备用写法（不想用预处理语句、或需要把口令直接写死时，手工执行这一句并把占位符换成真口令）：
--   CREATE USER IF NOT EXISTS 'p3app'@'127.0.0.1' IDENTIFIED BY '在这里填口令';
-- 注意：这样写会把口令留在命令历史/脚本里，只在临时排障时用。

-- 唯一的授权语句：p3blog 全库的四类 DML，仅此而已
GRANT SELECT, INSERT, UPDATE, DELETE ON `p3blog`.* TO 'p3app'@'127.0.0.1';

-- 立即让权限生效（正常情况下 GRANT 已即时生效，这里只是显式对齐老版本行为）
FLUSH PRIVILEGES;

-- 口令来源提示：部署日志里必须看到第二行，看到第一行说明还在用占位口令，先停下来改
SELECT IF(@p3app_pw_is_default = 1,
          '提示：正在使用开发占位口令（部署必须用 @p3app_pw 覆盖后再执行）',
          '提示：口令来自 @p3app_pw 覆盖值') AS `password_source`;

-- 自检输出：应恰好看到一行
--   GRANT SELECT, INSERT, UPDATE, DELETE ON `p3blog`.* TO 'p3app'@'127.0.0.1'
-- 不该出现任何 DDL、授权管理或 FILE 相关条目
SHOW GRANTS FOR 'p3app'@'127.0.0.1';

-- 口令轮换（手工执行，不在本脚本里自动改，避免每次部署都把口令重置）：
--   ALTER USER 'p3app'@'127.0.0.1' IDENTIFIED BY '新的随机口令';
--   -- 轮换后同步更新 /etc/p3blog/public.env 的 P3_DB_PASSWORD 并重启 p3-public 服务
