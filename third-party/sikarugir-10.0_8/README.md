# Wine Sikarugir 10.0 revision 8

本次在 macOS 27.0.1 / Apple M5 上核实的图形接口候选。下载地址、上游资产 SHA-256 和布局实测见 `provenance.json`。

上游 [Sikarugir-App/Engines](https://github.com/Sikarugir-App/Engines/releases/tag/v1.0) 提供免费的 Wine engine。它与 Sikarugir 的闭源 Launcher 是不同的组件；本机使用可只调用 engine 的 `bin/wine`。

Wine 授权为 LGPL-2.1-or-later。本目录所附 `UPSTREAM-WINE-LICENSE`、`COPYING.LIB`、`UPSTREAM-WINE-AUTHORS` 来自 Wine 的 `wine-10.0` 标签，属于基础 Wine 版本的版权与许可证记录。Sikarugir 修改版源码位置为 [Sikarugir-App/wine](https://github.com/Sikarugir-App/wine)，但本次未能核实 revision 8 二进制对应的完整 commit/patch/build recipe。因此不能把基础 Wine 源码当作已匹配此修改二进制的完整对应源码。

只读检查解压后的 revision 8 文件已确认 `winemac.so` 导出 `_macdrv_functions`。这提供 DXMT 建立 Metal view 所需的接口，但仍须以目标程序真实呈帧、输入、存档和音频测试为准。

原型先试用的 stock Wine Staging 11.20 能让 DXMT 列举 Apple M5 并建立 D3D11 设备，但目标程序随后因 Metal view 所需 Wine exports 缺失退出。因此只看到 GPU 名称或 D3D11 初始化不应算目标程序兼容通过。

原包的 `bin` 与 `lib/wine` 应保持相邻。`bin/wineserver` 依赖 `@rpath/libinotify.0.dylib` 且没有自己的 LC_RPATH；应在运行环境中提供明确的支持库搜索路径，或对本机管理的副本补相对 rpath 并记录/重新临时签名。`winemac.so` 等 Unix 模块的 rpath 是 `@loader_path/`。GStreamer 的直接依赖同样使用 `@rpath`，不要求固定全局 `/Library/Frameworks` 安装路径。

已有下载的 Gcenx Wine 包内支持库可以作为本机测试的供给来源；ABI、具体版本与实际加载结果需要本机验证，不能仅依据同名文件认定兼容。

新引擎应使用新的测试 prefix，避免在两个 Wine 大版本间来回迁移同一个运行目录。Unity 6 新输入系统在基础 Wine 10.0 上还有已知未实现接口的可能性；到达标题画面后仍应测试点击和键盘。
