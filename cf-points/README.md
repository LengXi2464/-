# 积分网站（Cloudflare Workers + D1 + Hono）

## 本地开发

1. 安装依赖（需要 Node 18+）
   npm i

2. 初始化本地 D1 数据库
   npm run db:local

3. 启动本地开发
   npm run dev

4. 打开前台与后台
   前台：http://127.0.0.1:8787/
   后台：http://127.0.0.1:8787/admin.html

## 部署到 Cloudflare

1. 创建 D1 数据库并绑定到 `wrangler.toml` 的 `cf-points-db`
   wrangler d1 create cf-points-db
   将生成的 `database_id` 填写到 wrangler.toml

2. 设置管理员 Token（自行选择强密码）
   wrangler secret put ADMIN_TOKEN

3. 迁移数据库（生产与本地）
   npm run migrate

4. 部署
   npm run deploy

## API 摘要
- POST /api/user/init { username }
- POST /api/events { username, title, points }
- GET /api/overview?username=xxx
- POST /api/redeem { username, reward_id }
- 管理端需要请求头 x-admin-token = ADMIN_TOKEN
  - POST /api/admin/rewards { action:create|update|delete, ... }
  - GET /api/admin/rewards
  - POST /api/admin/points { username, delta, reason? }
  - DELETE /api/admin/events/:id

## 注意
- 此为最小可运行版本（MVP），未包含复杂风控、审核流与多管理员权限；可在此基础上扩展。
