# 引擎适配规划与当前能力

## 目标与路线

AppBridge 是 macOS 上的程序兼容启动器。继续使用 Electron 管理应用与文件，通过现有 Wine / DXMT 运行 Windows 构建，无需用户安装 Unity 或 Unreal 编辑器，也不重新编译第三方游戏。

第一阶段（0.4.0）建立引擎识别、结构化启动预设、完整资源导入和统一诊断。第二阶段使用用户提供的完整程序逐个验证；第三阶段只根据实际失败证据补充依赖、图形与存档适配。保留现有 TyranoScript 样本原生加载路线。

## 第一阶段已实现

| 引擎 | 识别证据 | 启动适配 | 验证状态 |
| --- | --- | --- | --- |
| Unity | `UnityPlayer.dll`、同名 `_Data`、Mono / IL2CPP 文件特征；单个 DLL 仅给出较低置信度 | 可选 DX11；窗口 / 无边框全屏 / 尺寸参数；集中 `unity-player.log` | 识别与参数自动化测试通过，新增程序待实测 |
| Unreal Engine | 打包项目的 `Content/Paks`、项目二进制与 Engine 目录证据 | 可选 DX11；窗口 / 全屏 / 尺寸参数；尝试集中 `unreal-player.log`；保留用户选择的启动入口 | 目录导入与参数自动化测试通过，待实测 |
| Godot | EXE 同名外部 PCK 的有界文件头，可区分 3 / 4 与小版本 | 窗口 / 全屏 / 尺寸；可选版本对应 OpenGL；4.3 及以上可指定 `godot-player.log` | 版本闸门与参数自动化测试通过，待实测 |
| Ren’Py | `renpy` 运行代码、`lib` 与 `game` 目录 | 通用 Wine 路线，保持程序参数 | 识别自动化测试通过，待实测 |
| RPG Maker MV / MZ | 有效本地 manifest、入口与 `rpg_core.js` / `rmmz_core.js` | 通用 Wine 路线 | 识别自动化测试通过，待实测 |
| TyranoScript / NW.js | manifest、入口与 Tyrano 引擎文件 | Windows 构建使用通用 Wine；已核实的特定 TyranoScript 5 包仍可原生加载 | 新 Windows 构建待实测 |
| 未知或证据冲突 | 不可靠证据不强行指定引擎 | 通用 Wine，不添加其他引擎参数；允许手动选择 | 按具体程序验证 |

识别只读取已知位置的少量文件和有限目录，不执行程序内的配置脚本、不遍历整个磁盘。嵌入 EXE 的 Godot PCK、压缩 `package.nw` 等布局尚未覆盖。仅文件名包含 Unity、Shipping 等字样不足以判定引擎。

## 使用方式与数据

在所选 Windows 应用的“兼容设置”中选择引擎和图形预设。“自动”和“跟随程序”都保留当前程序的图形接口；DX11 / OpenGL 仅在明确选择且引擎允许时追加。显示参数仍由“显示设置”控制，选择跟随游戏时不覆盖画面尺寸。运行期间禁止修改兼容设置和入口。

旧版本已经使用的 Unity DX11 设置会保留。自动识别结果改变后，如果原图形预设不适用，会回到自动模式并记录原因；手动指定引擎的选择仍由用户控制。

每个应用的“数据与存档”文件夹集中保存：

- `runtime.log`：Wine 标准输出和错误输出。
- `launch-plan.json`：引擎证据、有效预设、完整参数、运行环境、预期日志和进程退出结果。
- 引擎自己的日志（在对应构建支持的情况下）。
- 私有 Windows 运行目录及程序生成的存档、设置和缓存。

Windows 日志参数使用经过检查的标准 `Z:` 映射。导出诊断会包含上述启动记录及可用引擎日志。进程正常退出不自动标记为兼容成功，仍需人工检查画面、交互与存档。

对于标准 Unreal 嵌套入口，只有识别到项目资源与引擎目录的明确证据，才把完整打包根作为导入范围；保留相对目录和原入口，不直接绕过启动器。其他布局需要结合实际样本处理。

## 第二阶段：收到测试文件后

| 类别 | 优先样本 | 验收内容 |
| --- | --- | --- |
| Unity | Mono 与 IL2CPP；x64 优先，再验证 x86；不同 Unity 版本 | 默认与 DX11 启动、开场视频、音频、输入、窗口 / 全屏、分辨率、首次存档及重启读取 |
| Unreal | UE4 / UE5；有明确 DX11 后端的完整打包目录 | 入口与资源完整性、着色器初始化、显示切换、图形预设、存档和日志 |
| Godot | 3.x / 4.x；外部与嵌入 PCK 分别记录 | 默认与 OpenGL 模式、尺寸切换、输入音频、`user://` 数据与日志位置 |
| 其他 | Ren’Py、MV / MZ、Tyrano / NW.js 各至少一份完整程序 | 导入、资源定位、文本与字体、视频、输入和存档 |

每份样本记录版本、架构、构建布局、使用预设、复现步骤和日志，再标记为通过、部分可用或失败。测试资源、商业游戏、存档与个人日志不提交到公开源码仓库。

## 当前边界

内置 DXMT v0.80 的主要路线是 D3D10 / 11；未将 DX12、硬件光追或所有 UE5 功能列为已支持。DX11 预设不能补回程序未打包的渲染后端。Godot 3 / 4 的图形参数不同，未知版本不套用新版本选项；自定义日志参数只用于确认支持的 Godot 4.3 及以上版本。Unreal Shipping 若在编译时关闭日志，启动参数不能恢复日志能力。

当前不自动下载或安装不明运行库，不修改程序脚本或绕过其启动、授权与在线服务。遇到具体缺失依赖再单独确定解决方案。

## 官方依据

- [Unity Player 启动参数](https://docs.unity.com/en-us/engine/6000.0/manual/unity-editor/command-line-arguments/player)
- [Unity 5.6 参数文档](https://docs.unity3d.com/560/Documentation/Manual/CommandLineArguments.html)
- [Unreal Engine 参数参考](https://dev.epicgames.com/documentation/en-us/unreal-engine/unreal-engine-command-line-arguments-reference)
- [Unreal Shipping 日志能力](https://dev.epicgames.com/community/learning/knowledge-base/vzvZ/unreal-engine-enabling-logging-in-shipping-builds)
- [Godot 3.6 命令行](https://docs.godotengine.org/en/3.6/tutorials/editor/command_line_tutorial.html)、[Godot 4.2 命令行](https://docs.godotengine.org/en/4.2/tutorials/editor/command_line_tutorial.html)
- [Godot 4.2 启动实现](https://github.com/godotengine/godot/blob/4.2/main/main.cpp)、[Godot 4.3 启动实现](https://github.com/godotengine/godot/blob/4.3/main/main.cpp)、[PCK 文件头实现](https://github.com/godotengine/godot/blob/4.4/core/io/file_access_pack.cpp)
- [DXMT v0.80 能力与使用说明](https://github.com/3Shain/dxmt/blob/v0.80/README.md)
