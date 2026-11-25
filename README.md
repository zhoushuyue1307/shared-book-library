# 共享数字图书库（Shared Digital Book Library）

软件工程 Assignment 1 的完整演示程序：在开源书签应用 bookmarker（MIT, Brad Traversy）的基础上，
扩展成一个**共享**的图书目录，带库存、借还、预约队列和版本号乐观锁。

零依赖：不需要 `npm install`，只需要 Node.js 18+。

## 运行

```bash
node server.js
```

打开 <http://localhost:3000>。改端口：`PORT=4000 node server.js`

数据保存在 `data.json`，重启不丢；页脚的「恢复示例数据」可以回到初始状态。

## 功能

| 区域 | 说明 |
|---|---|
| 顶部 | 当前用户、并发自检（诊断工具） |
| 工具栏 | 搜索书名 / 作者、按状态筛选、新增图书 |
| 图书卡片 | 可借数量、版本号 `vN`、借出人、备注、借书 / 还书 / 编辑 |
| 右侧 | 操作日志、预约队列 |

**九个动作**：新增图书、搜索、按状态筛选、借书、还书、预约排队、编辑图书、写备注、查看日志。

## 并发是怎么处理的（重点）

每条书记录带一个 `version`。借、还、编辑都要带上「客户端看到的版本」。

| 场景 | 处理方式 | 结果 |
|---|---|---|
| 两人同时借同一本书，**库存充足** | 先到者成功；后到者版本过期 → 自动用最新版本重试 | **两人都借到**，库存 -2 |
| 两人同时借最后一本 | 先到者成功；后到者重试后发现库存为 0 | 一人借到，**另一人进入预约队列** |
| 两人同时改同一条记录 | 后到者版本过期 → **不重试**，直接拒绝 | 一人保存成功，另一人被要求刷新 |

为什么借书可以重试、编辑不行：借书是「再加一个人借」，重试后重新判断库存是安全的；
编辑是覆盖字段，重试就等于把别人的修改抹掉，所以必须让人重新看一遍。

## 预约队列

库存为 0 时借书进入 FIFO 队列。归还时不重新上架，而是直接预留给队首
（卡片显示「🔒 已预留给 X」），其他人插队会被拒绝。

## 功能对照（报告 3.2 的 backlog）

| 编号 | 功能 | 位置 |
|---|---|---|
| BL-1 | 共享书目（新增 / 列表） | `POST /api/books`、`GET /api/state` |
| BL-2 | 库存感知的借还 | `POST /api/books/:id/borrow`、`/return` |
| BL-3 | 乐观锁：最后一本竞态 | `borrow()` 的版本校验 + 客户端重试 |
| BL-4 | 并发编辑冲突检测 | `PATCH /api/books/:id` + `editBook()` |
| BL-5 | 预约队列（FIFO） | `borrow()` 库存为 0 分支、`giveBack()` |
| BL-6 | 搜索与筛选（书名 / 作者 / 状态） | `public/index.html` 的 `render()` |
| BL-7 | 审计日志 | `addLog()` + 右侧「操作日志」 |
| BL-8 | 图书备注字段 | `editBook()` 的 `note` |

## 数据模型

```js
book        { id, title, author, copies, borrowers: [{ member }], version, reservedFor, note }
reservation { bookId, member }        // 数组顺序即 FIFO 顺序
log         { time, msg, type }       // 最近 60 条，仅内存
```

`available` 不单独存储，而是由 `copies - borrowers.length - (reservedFor ? 1 : 0)` 推导，
避免两个字段写歪。

## 接口

```
GET    /api/state                全部数据（书、队列、日志）
POST   /api/books                新增图书
PATCH  /api/books/:id            编辑（需 version）
POST   /api/books/:id/borrow     借书（需 version）
POST   /api/books/:id/return     还书（需 version）
POST   /api/reset                恢复示例数据
```

版本不匹配返回 `409`，响应体里带当前 `book`，客户端可以据此重试。

## 已知限制

- 没有登录鉴权，「当前用户」是前端填的名字。
- 单进程内存状态，适合小团队演示；换多实例需要把版本校验放进数据库事务。
- 审计日志只保留最近 60 条，不落盘。

## License

基于 [bradtraversy/bookmarker](https://github.com/bradtraversy/bookmarker)（MIT License）的概念扩展，
原项目版权归 Brad Traversy 所有；本仓库新增部分同样以 MIT 发布。
