# P2-M0基线说明

本目录保存目标交互与Mock闭环的测试数据，不代表全部能力已经实现。

`ui-baseline.json`中的检查只扫描前端源码中是否存在约定的结构和文案。它用于快速发现明显缺失，不能证明浏览器中的布局、滚动、焦点、可访问性或端到端功能正确。最终功能验收仍需浏览器交互、API状态和业务仓库结果共同验证。

`class-committee-mock-baseline.json`通过`currentSupport`记录基线建立时的产品现状。目标态字段与当前支持字段必须分开读取，禁止把目标期望当作已通过结果。

`tests/evaluation/p2-m0-current-probe.mjs`是现状红灯探针。exit 0表示全部探针通过，exit 2表示正确捕获产品缺口，exit 1表示探针自身异常。该脚本不进入`npm test`。
