# public/xqwlight/ — XQWLight（象棋小巫师）经典引擎

本目录下的三个文件是**上游原样搬运**的第三方程序（未做任何修改，仅从 GBK 转为 UTF-8）：

| 文件 | 来源 | 许可 |
| --- | --- | --- |
| `position.js` | [xqbase/xqwlight](https://github.com/xqbase/xqwlight) `JavaScript/position.js` | GPL-2.0-or-later |
| `search.js` | 同上 `JavaScript/search.js` | GPL-2.0-or-later |
| `book.js` | 同上 `JavaScript/book.js`（开局库） | GPL-2.0-or-later |

- 上游 commit：`6221733f1f79b3acb44cce6f83dc6100443cb2c9`
- 作者：Morning Yellow（www.xqbase.com），Version 1.0，Last Modified: Sep. 2012
- 合计约 366 KB，纯 JavaScript，无需构建，无外部权重

`engine-worker.js` 是本项目自己写的胶水层（MIT）：在 classic worker 里
`importScripts` 上面三个文件，对外提供 `init` / `go` 消息接口。
把 GPL 代码留在独立资源文件里、由独立 worker 加载，而不是 import 进
`src/` 后被打包，是为了不让 GPL 传染到本项目 MIT 的主程序。

引擎能力：迭代加深 + PVS + 空步剪枝 + 静态搜索 + 置换表 + 杀手/历史启发
+ 96KB 开局库。棋力定位是「教学级模型引擎」（上游定位：a simple but
strong XiangQi AI algorithm），比神经网络档弱，但零下载、零后端依赖。
