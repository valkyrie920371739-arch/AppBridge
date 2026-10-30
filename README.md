# AppBridge

适用于 Apple 芯片 Mac 的本地应用库与 Windows 程序兼容启动器。使用 Electron 提供简洁的 Mac 风格界面，通过独立 Wine 运行环境启动用户自行导入的程序。

支持模糊搜索、程序与数据统一管理、数据目录迁移，以及窗口、全屏、Dock 自动隐藏和模拟分辨率设置。实际兼容性取决于目标程序；本仓库不包含游戏、存档、运行环境二进制或安装包。

## 开发环境

- macOS 14 或更高版本，Apple Silicon。
- Node.js 22.12.0 或更高版本及 npm。
- Xcode Command Line Tools（用于编译两个原生辅助程序和重新生成图标）。
- 准备与运行 Windows 兼容环境时，需要已安装 Rosetta 2。
- 完整构建需要联网下载 Electron 和三个固定版本的上游运行组件，并预留数 GB 可用空间。

## 安装依赖与测试

在仓库根目录运行：

```sh
npm ci
npm test
```

Electron 固定为 `45.1.0`，由 npm 获取官方发行版。测试使用 Node 内置测试框架，不启动 Wine 或游戏；仅检查源码时可直接执行 `node --test tests/*.test.cjs`。

## 准备 Windows 运行组件

下载脚本需要 Python 3.11 或更高版本，以及 macOS 自带的 `curl`。以下命令将组件保存在被 Git 忽略的 `.cache` 中，并核对固定大小与 SHA-256：

```sh
python3 scripts/download-asset.py https://api.github.com/repos/Sikarugir-App/Engines/releases/assets/604320750 .cache/WS12WineSikarugir10.0_8.tar.xz 166321980 2a6bcf2a3bf13cddf825599b6bc1e3659cbf71e1282c6d77141a92f6ac8d4c68
python3 scripts/download-asset.py https://api.github.com/repos/Gcenx/macOS_Wine_builds/releases/assets/687305161 .cache/wine-staging-11.20-verified.tar.xz 227975304 4df858c5e72920deaf123cbc29fa2b9e64c23bcf2dea59e0a7047b879b9cd952
python3 scripts/download-asset.py https://api.github.com/repos/3Shain/dxmt/releases/assets/403345414 .cache/dxmt-v0.80-verified.tar.gz 18681669 8f260e36b5739e68f3bad613381441385c4dc7b85b78ba8de653d5a6a264529d
node scripts/prepare-runtime.cjs
```

准备脚本组合 Sikarugir Wine 10.0 revision 8、Wine Staging 11.20 的顶层 macOS 支持库和 DXMT 0.80，生成 `runtime/` 与 `runtime-manifest.json`。这是本项目的实验性组合，不能据此推断所有 Windows 软件都能运行。组件来源和许可证见 [third-party](third-party/README.md)。

## 构建应用

```sh
npm run build
```

输出位于 `build/`，包含 `AppBridge.app`、压缩包、构建记录及启动脚本。构建默认执行本机临时签名与完整性检查；该签名不代表 Apple 开发者签名或公证。跳过运行组件准备可构建界面，但该构建不包含 Windows 运行环境。

构建基座依次选择 `APPBRIDGE_BASE_APP` 指定的应用、已有的 `base/AppBridge.app`、npm 安装的 `node_modules/electron/dist/Electron.app`。例如使用自行准备的 Electron 45.1.0 基座：

```sh
APPBRIDGE_BASE_APP="/absolute/path/Electron.app" npm run build
```

应用图标由项目自有的 Swift 绘图脚本生成；修改后可执行 `swift scripts/create-app-icon.swift` 重新生成。构建在本机临时目录中完成签名，再复制到输出目录，供 iCloud 工作区使用。

## 目录

| 路径 | 内容 |
| --- | --- |
| `src/` | Electron 主进程、界面、应用导入与兼容环境管理 |
| `native/` | 显示适配和运行进程检测辅助程序源码 |
| `scripts/` | 图标生成、运行组件准备、构建与本机启动脚本 |
| `tests/` | Node 自动化测试 |
| `assets/` | AppBridge 自制图标 |
| `third-party/` | 第三方来源、许可证及追溯记录 |

运行缓存、导入的程序和存档由 AppBridge 管理，并可在“文件与数据”中查看或迁移。它们不会作为本仓库源码上传。

## 许可

AppBridge 当前标记为 `UNLICENSED`，公开源码用于查看和审阅，尚未授予开源许可。第三方组件分别适用其自身许可证；Lucide 图标声明位于 `src/Lucide-LICENSE.txt`，Electron、Wine 和 DXMT 等说明保留在 `third-party/`。仓库不附带这些组件的运行二进制；公开分发完整安装包需要另外核对各依赖的授权和源码提供要求。
