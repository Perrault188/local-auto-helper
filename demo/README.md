# Demo server

`server.mjs`提供本地静态页面、JSON接口、SQLite持久化和Mock执行通道。

在仓库根目录运行`npm start`后打开`http://127.0.0.1:4173`。服务固定监听本机回环地址，不适合作为公网服务部署。

运行数据默认写入`demo/local-data`。删除该目录可以清除本地演示状态。
