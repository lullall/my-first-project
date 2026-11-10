# my-first-project · lullall 的个人主页与作品集

一个纯 HTML + CSS 的个人主页/博客站点，也是我的练手项目集合地。没有框架、没有构建步骤，改完直接提交就能通过 GitHub Pages 访问。

在线地址：https://lullall.github.io/my-first-project/

## 站点结构

```
├── index.html          # 单页主页：关于 / 项目 / 技术栈 / 最近动态
├── style.css           # 全部样式（含深色模式与响应式）
├── projects/
│   ├── weather-dashboard/   # 天气仪表盘（Open-Meteo API + Chart.js）
│   └── translator-app/      # 极简翻译（Google / MyMemory 双引擎）
├── hello.txt           # 第一次提交留下的纪念文件
└── README.md
```

## 收录项目

| 项目 | 技术栈 | 说明 |
| --- | --- | --- |
| [天气仪表盘](projects/weather-dashboard/) | HTML / CSS / JS / Chart.js | 城市搜索、定位、实时天气、24 小时温度折线与 3 天预报，背景随天气切换 |
| [极简翻译](projects/translator-app/) | HTML / CSS / JS | 中英日三语翻译，长文自动分段、失败重试、双引擎降级，支持暂停与中止 |
| [我的博客](https://github.com/lullall/vip-blog) | React / Node.js / SQLite | 前后端分离，JWT 登录、文章增删改与点赞 |
| [本主页](https://github.com/lullall/my-first-project) | HTML5 / CSS3 | 纯静态单页，GitHub Pages 托管 |

## 本地预览

直接用浏览器打开 `index.html` 即可；如果希望资源和相对路径与线上一致，也可以起一个静态服务：

```bash
# 任选其一
python -m http.server 8000
npx serve .
```

然后访问 http://localhost:8000 。

把新的小项目放进 `projects/` 目录，并在 `index.html` 的项目区加一张卡片，站点就更新好了。

## 部署

推送到 `main` 分支即可，GitHub Pages 会自动发布根目录内容：

```bash
git add .
git commit -m "更新内容"
git push origin main
```

## 技术栈

- HTML5（语义化标签）
- CSS3（Grid / Flex、深色模式、媒体查询）
- JavaScript（ES6+、Fetch API、Canvas）
- Git / GitHub（分支管理与 Pages 部署）

## 许可

仅作个人学习与展示用途。
