# AppBridge 0.2.0 第三方组件追溯

核对日期：2026-10-30（Asia/Shanghai）。本目录保存本机构建用组件的许可证和来源记录。组件的名称、授权和权利归原作者；AppBridge 不将免费组件称为自己的原创代码。

后续目标程序实测否决了 stock Wine Staging 11.20 + DXMT v0.80 的组合：缺少建立 Metal view 所需的 Wine 导出接口。改用 Wine Sikarugir 10.0 revision 8 的记录见 `sikarugir-10.0_8/`；该引擎已在本机只读检查确认具有 `_macdrv_functions`，实际运行结果另以测试报告为准。下列 11.20 资料仍作为曾测试组件及支持库来源保留。

## Wine Staging 11.20

- 二进制发布者：[Gcenx/macOS_Wine_builds 11.20](https://github.com/Gcenx/macOS_Wine_builds/releases/tag/11.20)。
- 文件：`wine-staging-11.20-osx64.tar.xz`，227,975,304 字节。
- SHA-256：`4df858c5e72920deaf123cbc29fa2b9e64c23bcf2dea59e0a7047b879b9cd952`，来自上游 GitHub release asset API 的 digest。
- Wine 版权和 LGPL-2.1-or-later 全文：`wine-11.20/LICENSE`、`wine-11.20/COPYING.LIB`；作者列表：`wine-11.20/AUTHORS`。
- 基础源码：Wine `wine-11.20`，commit `7298a818b79446bae153b8d5aa27235ab3703bf9`。
- Staging 补丁集：`wine-staging/wine-staging` 的 `v11.20`，授权见 `wine-11.20/STAGING-LICENSE.md` 及各补丁。
- 包维护者公开的构建配方和额外 Vulkan patch 已保存在 `wine-11.20/Portfile`、`wine-11.20/0001-win32u-Enable-host-Vulkan-portability-enumeration.diff`。该配方属于 MacPorts overlay commit `850f5330ed500a87bdcf8441763ad6cf4109aedc`，并非发布者提供的逐字节可复现保证。
- 上游声明包含 Wine Gecko 2.47.4、Wine Mono 11.3.0、GStreamer.framework 1.28.1；其余运行依赖包括 freetype、gnutls、libinotify、SDL2、MoltenVK 和 Vulkan loader。各组件有自己的许可证。

本机构建保持 Wine 为可替换的外部目录，以独立子进程调用，不修改 Windows 程序和游戏资源。Wine 与原应用的兼容性仍应逐个验证。

## DXMT v0.80

- 项目：[3Shain/dxmt v0.80](https://github.com/3Shain/dxmt/releases/tag/v0.80)。
- 文件：`dxmt-v0.80-builtin.tar.gz`，18,681,669 字节。
- SHA-256：`8f260e36b5739e68f3bad613381441385c4dc7b85b78ba8de653d5a6a264529d`，来自上游 GitHub release asset API 的 digest。
- 固定源码 commit：`589adb780354b461645b29999cefaf533594ee99`。
- 本版本采用 MIT，全文见 `dxmt-v0.80/LICENSE`。上游明确声明 v0.80 是最后一个采用 MIT 的发行版；不能据此推断更新版本也采用 MIT。
- 已附源码中复用 DXVK 的 MIT notice（`DXVK.LICENSE`）和 LLVM 15 的许可证文本（`LLVM-15-LICENSE.TXT`）。DXMT 的源码配方静态链接 LLVM；实际 LLVM 小版本应以对应上游构建记录核对。

## 发布边界与完整源码

本目录是来源和授权追溯记录，并不声称已经完成整个 Wine 二进制包的再分发合规审计。只附许可证文本和源码网址，不自动构成 LGPL 要求的完整对应源码交付或书面源码提供要约。

本次核对的上游 Wine 和 DXMT 二进制 tarball 未含 `LICENSE`、`COPYING` 或 `AUTHORS` 文件（清单记录见 `wine-11.20/archive-notice-paths.txt`），因此本目录补存了已经核实的主要 notice。若把 Wine、GStreamer、Gecko、Mono 及其所有依赖一起公开再分发，仍需保存各个实际二进制对应版本、构建/补丁记录、必要 notice，并按适用许可证落实完整对应源码的提供方式。无法追溯的依赖不应被标为已完成审核。

建议当前版本继续作为本机开发测试，或让安装器从指定上游直接获取并校验可替换组件。公开发行包的依赖与源码审计单独完成。AppBridge 未在此代用户作出长期源码提供承诺。

精确下载地址、源码地址与哈希见 `sources.json`。Wine 的 LGPL 具体要求以随附 `COPYING.LIB` 为准；GStreamer 官方说明见 [GStreamer licensing](https://gstreamer.freedesktop.org/documentation/frequently-asked-questions/licensing.html)。
