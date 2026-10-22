# investment-report-channel-publishing

> 把每日投资记录同时发布到 **小红书（私密）** 和 **X（公开）** 的自动化工具，含发布后取证与纠错流程。

[![Platform](https://img.shields.io/badge/platform-macOS-lightgrey)]()
[![Runtime](https://img.shields.io/badge/runtime-Bun-black)]()
[![License](https://img.shields.io/badge/license-MIT-blue)]()

---

## 这个仓库解决什么问题

每天收盘后手动发一条投资日报到两个平台，看起来简单，实际坑很多：

| 坑 | 说明 |
|---|---|
| **隐私** | 券商名、账号必须打码，漏一次就删不掉（小红书没有删除 API） |
| **数据失真** | 交易系统里的 `pending` 不等于成交，写进日报就是假数据 |
| **重复发帖** | 同一交易日发两篇，或者同一推文发两次 |
| **自证成功** | 脚本打印 "Posted!" 不等于真的发出去了 |
| **平台差异** | 小红书要排版，X 只能浓缩到 280 字符 |

这个仓库把上述问题的处置方式写成可复用的脚本 + 规则文档。

---

## 功能特性

| 能力 | 脚本 | 说明 |
|---|---|---|
| X 发布 | `scripts/x-publish-report.ts` | 全程走 CDP，不碰剪贴板；自动清草稿残留、焦点仿真、图片上传、内容自检 |
| X 取证 | `scripts/x-verify-post.ts` | 发布后独立读页面，验证开头/配图/标签——**脚本自述不算数** |
| X 删除 | `scripts/x-delete-tweet.ts` | 发错了走 CDP 自动删除（Delete → 确认） |
| X 清场 | `scripts/x-clear-compose.ts` | 关旧标签 + 新开 compose 页，比 reload 稳 |
| 打码 | 外部依赖 | 券商名 + 账号区域涂黑后再上传 |

**核心理念：发布 ≠ 成功，取证才算。**

---

## 项目结构

```
.
├── SKILL.md                    # 完整规则文档（版式、铁律、踩坑记录）
├── scripts/
│   ├── x-publish-report.ts     # X 发布主脚本
│   ├── x-verify-post.ts        # 发布后取证
│   ├── x-delete-tweet.ts       # 删除推文
│   └── x-clear-compose.ts      # 清空编辑器
├── README.md
└── LICENSE
```

---

## 依赖

| 依赖 | 用途 | 安装 |
|---|---|---|
| **Bun** | 跑 TS 脚本 | `curl -fsSL https://bun.sh/install \| bash` |
| **Chrome** | X 发布必须用真实浏览器 | 系统自带或 [下载](https://www.google.com/chrome/) |
| **bun + node** | 脚本内置 fetch / CDP 客户端 | 随 Bun 提供 |

**小红书发布**需要第三方 CLI（`xhs`），本仓库不包含，请自行安装并配置 cookie。

---

## 快速使用

### 1. 准备 X 专用 Chrome profile

脚本会连一个**独立的** Chrome profile（不干扰日常浏览器）：

```bash
# 首次需要在这个 profile 里手动登录一次 X
open -na "Google Chrome" --args \
  --user-data-dir="$HOME/Library/Application Support/baoyu-skills/chrome-profile" \
  --remote-debugging-port=9222
```

脚本通过 `pgrep` 动态发现端口，不需要固定端口。

### 2. 发布

```bash
bun scripts/x-publish-report.ts \
  --text /tmp/post.txt \
  --image /tmp/account_masked.jpg \
  --image /tmp/position.jpg \
  --submit
```

- 不加 `--submit` = 只填充 + 自检，不发布（预览模式）
- 退出码：`0` 成功 / `2` 内容自检失败已中止 / `3` 浏览器或登录问题 / `5` 编辑器清不干净

### 3. 取证（**必做**）

```bash
X_HANDLE=your_handle bun scripts/x-verify-post.ts
```

输出会列出当天所有推文的时间、链接、开头、配图数、标签统计和判定。

### 4. 发错了

```bash
X_HANDLE=your_handle bun scripts/x-delete-tweet.ts <tweet_id>
# 页面出现 "Your post was deleted" = 成功
```

---

## 正文版式

`SKILL.md` 里定义了两套模板：

| 平台 | 逻辑 | 特点 |
|---|---|---|
| 小红书 | **排版** | 分块 + 分隔线 + emoji 数据行，竖屏滑动友好 |
| X | **浓缩** | 前 3 行定生死，每行 ≤20 字，emoji ≤1 个 |

两者**内容同源、结构不同**，不互相照搬。

---

## 五条铁律（摘自 SKILL.md）

1. **发布成功判据 = 推文链接 / 页面跳转**，脚本自述不算
2. **交易信息只认券商截图**，交易系统的 `pending` 不等于成交
3. **同一交易日只发一篇**，发布前先查重
4. **小红书发前必须核对到位**——删除 API 不可用，发出去只能手动改
5. **优先发布，其次纠错**——X 能删重发，但不是随便发的理由

---

## 踩坑记录（SKILL.md 有完整版）

| # | 坑 | 处置 |
|---|---|---|
| 1 | 编辑器内容层层叠加 | 每次 reload + 校验 len |
| 2 | Draft.js 的 `innerText` 清空静默失效 | 关闭标签重开 |
| 3 | 弹窗内发布按钮是 `tweetButton` 不是 `tweetButtonInline` | 精确定位 |
| 4 | 剪贴板只送前台窗口 | 弃用剪贴板，全 CDP |
| 5 | 专用 Chrome 可能无窗口、端口随机 | 动态发现 + 自动开页 |
| 6 | 后台 Chrome 无焦点，`Input.insertText` 静默失效 | `Emulation.setFocusEmulationEnabled` |
| 7 | reload 后 X 恢复草稿，残留字符拼到正文最前 | 先 Cmd+A + Backspace 清空，清不净就中止 |

---

## FAQ

**Q: 为什么不用 X 官方 API？**
A: 需要开发者账号 + 付费档位。CDP 用真实浏览器登录态，零成本、行为一致，代价是页面改版时脚本要跟着修。

**Q: 小红书为什么不用 API？**
A: 个人号没有公开的发布 API。社区 CLI 基于 cookie 和网页接口，能力有限（**删除功能已下架**）。

**Q: 能不能支持其他平台？**
A: 可以。`x-publish-report.ts` 的 CDP 思路通用，换掉选择器即可。

**Q: 这是投资建议吗？**
A: 不是。这是一个**发布工具**，不包含任何投资判断逻辑。所有内容由使用者自己产出。

---

## 免责声明

本仓库只包含**工具脚本和流程文档**，不含任何投资建议、行情数据或他人内容。
使用者需自行确保发布内容合规，并自行承担发布行为的一切后果。

---

## License

MIT
