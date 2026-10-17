# STC C251 Workbench · 0.1.2

此工作版本尚未发布到 GitHub Releases；已发布的 0.1.0 不受本地开发影响。

在 VS Code 编辑代码，调用本机 Keil C251 编译，并通过 CH340 串口识别和烧录 STC32G12K128。

**独立烧录已在 STC32G12K128（BSL 7.4.5U）上完成真实验证。** 插件不启动官方 STC-ISP；烧录前请按提示手动按开发板 RES。默认仅写入代码区，保留 EEPROM 与硬件选项。

[下载安装包](https://github.com/blueyeswhitedragon/stc-c251-workbench/releases) · [反馈问题](https://github.com/blueyeswhitedragon/stc-c251-workbench/issues) · [更新记录](CHANGELOG.md)

本项目为独立社区项目，与 STC、Keil/Arm、Microsoft 无隶属或官方支持关系。

## 环境要求

- Windows 本机 VS Code 1.90 或更新版本；必须信任当前工作区。
- 已安装且有合法使用许可的 Keil µVision + C251。插件不附带编译器，也不转换工具链。
- 识别和独立烧录另需 Python 3.10+、CH340 驱动及开发板；编译不依赖 Python。
- 关闭官方 STC-ISP 后再编译/识别，避免占用串口或它的 HEX 自动下载监听。

## 安装和首次编译

1. VS Code 扩展面板右上角 `…` → **从 VSIX 安装…**，选择下载或本地构建的 `stc-c251-workbench-<版本号>.vsix`。
2. 打开包含 `Project` 与 `Libraries` 的完整工程根目录，保留原目录结构。
3. 点击左侧 **STC** 图标 → **导入 Keil 工程**，选择现有 `.uvproj`；多个 Target 时按提示选择。
4. 点击 **Build** 或 **Rebuild**。找不到 Keil 时，从命令面板运行 `STC: 设置 Keil 路径`，选择 `UV4.exe`，不要选择快捷方式。
5. 在“输出 → STC C251 Workbench”查看日志；可定位的编译诊断显示在“问题”面板。编译成功后自动检查已有 HEX 产物，但不下载。

建议初次使用工程副本。Build 使用工程原有优化、宏、头文件、链接地址等配置；启用的编译前后命令会另行提示确认。Build 会先保存打开的文件，也会更新 Keil 工程输出文件。

## 只读识别与 RES

1. 首次点击 **识别环境**，确认创建独立 Python 环境。依赖 wheel 随插件附带，安装不访问网络、不改系统 Python 或 PATH。
2. 找不到 Python 时，在插件设置中将 `pythonPath` 设置为 Python 可执行文件完整路径，再重试。
3. 连接 Type-C，点击 **串口**，选择开发板的 CH340 端口。COM 号可能随插口变化，请以本机枚举结果为准。
4. 点击 **识别芯片**，准备/打开串口时先不要按键；**等通知或侧栏出现“等待 RES”倒计时后，再按一下 RES**。读取阶段无需再按，完成后串口释放。
5. 超时/取消可点击 **重新识别**；取消中需先等待后端退出。若 USB 拔插导致端口号变化，先重新选择串口。其他串口工具占用时先关闭它们再重试。
6. 如果板子停在下载模式，可在操作结束后再按 RES 恢复应用运行。同步/断开报文和手动复位可能影响当前程序运行，但不会擦写。

识别会发送同步/断开报文，但不会发送擦除、写程序、写配置或调频命令。只读不代表运行状态完全不变：按 RES 会重启板子。原始状态记录保存在 VS Code 的插件全局存储中，不是程序/EEPROM 备份。复位脚和 EEPROM 映射未经验证，界面不把通用 STC8 解码结果当作事实。

高级用户可用 `probePythonPath` 指向已安装 pyserial 3.5 / tqdm 4.70.1 / colorama 0.4.6 的独立 Python；留空使用插件管理的环境。`probeTimeout` 默认 180 秒，`buildTimeout` 默认 300 秒。进行中的操作可点通知里的取消或侧栏“取消当前操作”。

## 当前边界

- 主要验证对象是 STC32G12K128 + Keil C251 + CH340；不是 STM32 插件，不保证其他 STC 型号兼容。
- HEX 校验只检查格式、校验和、绝对地址、重复地址等，不证明这些地址可安全烧入。
- STC32 硬件选项保留、EEPROM/复位脚设置、完整地址范围及写后校验确认前，不开放烧录；没有隐藏解锁设置。
- 未提供自动复位、调试器、串口终端、完整 C251 智能补全或 Keil 工程配置编辑器。代码高亮/基础编辑由 VS Code 提供；通用 C/C++ 扩展对 C251 关键字可能误报。
- 原生源文件列表可点击编辑；带行号的诊断可跳转，没有行号的链接器错误仍需查看完整日志。
- Keil 自身异常、许可证问题、USB 拔插、串口占用会导致操作失败，插件不会为此尝试烧录或修改芯片选项。

## 开发与验证

开发需要 Node.js 20+ 和 Python 3.10+；建议使用当前受支持的 Node.js LTS。编译插件不需要 Keil，编译单片机工程才需要 Keil C251。

```powershell
git clone https://github.com/blueyeswhitedragon/stc-c251-workbench.git
cd stc-c251-workbench
npm ci
npm test
npm run compile
node scripts/licenses.js
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install --no-index --find-links python/wheels pyserial==3.5 tqdm==4.70.1 colorama==0.4.6
.\.venv\Scripts\python.exe -m unittest discover -s test -p "test_*.py"
npm run package
```

安装包输出到本仓库的 `artifacts/` 目录。F5 使用扩展开发宿主（先运行 compile）。29 项 JavaScript 和 20 项 Python 测试不需要硬件串口，其中包含异常注入、恢复测试及上游烧录边界的内存模拟，不能代替实机覆盖。

烧录安全边界、手册页码及实机验证记录见 [烧录安全核验](docs/FLASH_SAFETY.md)。模拟测试不会打开串口，也不能替代实机验证。

独立后端的分层接口和开放条件见 [独立烧录后端分阶段设计](docs/INDEPENDENT_FLASH_PLAN.md)。
未来如进行专用测试板验证，可使用 [实机验证记录模板](docs/HARDWARE_VALIDATION_PROTOCOL.md)；当前插件不会自动执行其中的写入步骤。

`test/integration-identify/index.js` 是可选的只读硬件验收入口，不属于 `npm test`。它要求隔离的 VS Code 用户数据和扩展目录、名为 `stc-identify-test` 的空测试工作区，以及显式设置 `STC_HARDWARE_TEST=1`、`STC_HARDWARE_PORT`、`STC_HARDWARE_PYTHON`。运行时会打开选定串口、验证取消/重新打开，再等待手动 RES；不运行 Build 或烧录。测试报告只写到本地测试工作区，请勿上传原始采集。

`test/integration/index.js` 与 `test/integration-error/index.js` 是维护者使用的 Keil 实机工具链测试入口，依赖未公开的本地测试工程；普通贡献者只需运行上述离线测试。集成测试**只允许指定命名的完整工程副本**，会编译副本，但不会打开硬件串口。不要对唯一一份工作工程运行它们。

首版已在 Windows、VS Code 1.141.0、Keil C251 5.60 上验证真实 Build/Rebuild、HEX 检查与错误定位；只读后端曾在 STC32G12K128 上识别成功。最终插件中的实机识别流程尚需进一步覆盖，不代表已验证烧录或所有设备兼容性。

## 后续计划与贡献

- 扩展编译日志和工程兼容性测试。
- 改善首次环境检查、串口选择和只读识别体验。
- 增加不接硬件的 STC32 状态模型与 HEX 分块模拟，用于验证数据边界和 UI 流程；该模拟不会生成可直接发送的 ISP 写包。
- 在确认 STC32 配置保留、地址映射和写后校验后，评估开放烧录。

欢迎通过 Issues 提交问题或通过 Pull Request 贡献代码。请提供系统/工具版本、脱敏后的错误摘要和复现步骤；不要提交个人路径、设备原始采集、固件、Keil 许可证或其他私密内容。涉及硬件擦写的改动必须独立审查，不能以隐藏设置绕过当前保护。

源码采用 MIT；第三方协议库和依赖遵守各自许可证，见 [第三方说明](THIRD_PARTY_NOTICES.md) 与 [完整许可证](THIRD_PARTY_LICENSES.txt)。不附带用户工程、固件、Keil/STC-ISP 可执行文件或许可证。Python wheel 保留原许可证，协议库保留上游版权声明。使用者需自行获得合法的 Keil C251 使用许可。
