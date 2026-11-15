# Desktop Pet Player

一个在桌面上播放角色动画的小工具。宠物窗口透明、可以拖动，默认置顶。打开应用即可看到内置示例，也可以导入自己的角色素材。日常运行和导入都可离线完成。

## 安装

Windows x64 用户可从 [Releases](https://github.com/BitCrowder/desktop-pet-player/releases) 下载 `DesktopPetPlayer-Setup-…-x64.exe`。双击安装，完成后从开始菜单打开 **Desktop Pet Player**。安装按当前用户进行，完成页保留「Launch Desktop Pet Player」勾选即可立即运行，无需另外安装 Node.js。

### 从 1.0.0 升级

先在桌宠或托盘菜单点「退出」，再双击新版安装包覆盖安装。已导入的角色、大小、位置和「自由活动」设置会继续使用。新版按原比例绘制图集，滑翔和散步结束后恢复待机。自定义图集本身的画面内容取决于角色包。

初次安装时，Windows 可能会提示发布者未知。发行页提供 SHA-256 校验文件，可用 PowerShell 的 `Get-FileHash .\DesktopPetPlayer-Setup-1.1.0-x64.exe -Algorithm SHA256` 核对。Windows 32 位系统不在支持范围内。

## 桌面操作

| 操作 | 效果 |
| --- | --- |
| 拖动宠物 | 把宠物放到屏幕上合适的位置 |
| 单击宠物 | 播放装可爱的动作 |
| 双击宠物 | 播放打滚动作 |
| 右键宠物 | 选择动作、导入角色包或切换「自由活动」 |
| 打开系统托盘菜单 | 显示、隐藏、重置位置或退出 |

自定义角色可提供八个动作，包括待机眨眼、装可爱、滑翔、抱尾巴小睡、吃零食、打滚、探头和走两步。

## 导入角色

将 `manifest.json` 和角色的 WebP 或 PNG 图集放在同一个文件夹。右键宠物，选择「导入角色包…」，再选中 `manifest.json`。应用把导入的角色复制到本机的 `%APPDATA%\DesktopPetPlayer` 数据目录。图集每格对应一帧，按从左到右、从上到下的顺序播放。每组动作可分别设置帧尺寸、每行列数和逐帧时长。

`manifest.json` 的 `version` 为 `1`。`animations` 需要包含 `idle`、`act-cute`、`glide`、`tail-nap`、`snack`、`tantrum-roll`、`sneaky-peek` 和 `tiny-steps` 八项。每项填写以下字段。

| 字段 | 内容 |
| --- | --- |
| `file` | 同一文件夹内的 WebP 或 PNG 文件名，如 `idle.webp` |
| `frameWidth`、`frameHeight` | 每帧宽和高，单位为像素 |
| `columns` | 图集每行的帧格数 |
| `frameDurationsMs` | 帧时长数组，单位为毫秒，顺序与图集一致 |
| `loop` | 循环播放提示，填写 `true` 或 `false`。桌面点击及菜单触发的动作按交互逻辑播放 |

## 从源码运行

准备 Node.js 22.15 或更新版本，在项目目录运行 `npm ci` 后执行 `npm start`。要生成公开版 Windows x64 安装包，先安装 NSIS 3.13，再运行 `npm run build:win`。如果 NSIS 未加入 PATH，把 `MAKENSIS_PATH` 设为编译器的完整路径。输出位于 `dist/windows/public`。

## 许可

本项目的代码、文档及内置示例素材采用 MIT 许可。第三方组件与自行导入的素材适用各自的许可。详见 [LICENSE](LICENSE) 和 [ASSET-NOTICE.md](ASSET-NOTICE.md)。
