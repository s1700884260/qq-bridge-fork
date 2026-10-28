# 发布到 GitHub 的两种方式

仓库已经在 `E:\dp\qq-bridge-fork` 初始化好并提交了一次（`main` 分支，150 个文件，约 2.3MB 工作区）。
git 用的是便携版 `E:\dp\tools\mingit\cmd\git.exe`，不需要安装。

## 方式 A：有 git 认证（最快，一次搞定）

1. 在 GitHub 网页上新建一个**空仓库**（不要勾选 README / .gitignore / license），记下地址，
   例如 `https://github.com/你的用户名/qq-bridge-fork.git`。
2. 在本机执行（把地址换成你的）：

```powershell
$git = 'E:\dp\tools\mingit\cmd\git.exe'
cd E:\dp\qq-bridge-fork
& $git remote add origin https://github.com/你的用户名/qq-bridge-fork.git
& $git push -u origin main
```

3. 推送会要求登录。推荐在 GitHub → Settings → Developer settings → Personal access tokens
   生成一个 **classic token（勾选 `repo`）**，然后在密码提示处粘贴 token（用户名填你的 GitHub 用户名）。
   token 只用于这次推送，用完可以立刻删除。

## 方式 B：不想装/不想配 git（网页上传）

1. 在 `E:\dp` 下把仓库打包成 zip（排除 `.git`）：

```powershell
$src = 'E:\dp\qq-bridge-fork'
$zip = 'E:\dp\qq-bridge-fork-src.zip'
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Get-ChildItem $src -Force | Where-Object { $_.Name -ne '.git' }).FullName -DestinationPath $zip
```

2. GitHub 新建空仓库 → **Add file → Upload files** → 把 zip 拖进去 → Commit。
   （zip 里的文件会被当成一个压缩包提交，用户需要自己解压，观感差一点，但能用。）
   更好的做法：解压 zip 后把**文件夹里的内容**整体拖进去上传。

## 方式 C：交给我推送

把「仓库地址 + 一个有 `repo` 权限的 PAT」发我，我直接在这台机器上用便携版 git 推送完，
推送后建议你立刻在 GitHub 上删掉那个 token。

## 推送前自查（都已完成，改代码后建议重跑）

- [x] `config.json`、`state/`、`node_modules/` 没有进版本库（`.gitignore` 生效）
- [x] 全仓库扫描：无个人 QQ 号、无 `C:\Users\<name>` 路径、无 API key
- [x] `install.ps1` / `check.ps1` / `uninstall.ps1` 在本机实测跑通
- [x] README 顶部有 fork 说明与三步上手，底部有致谢与赞助段
- [x] `docs/DEMO.md`：30 秒演示分镜 + 发帖文案 + 赞助文案

## 推送之后

1. 仓库 Settings → 加上 Topics：`qq` `deepseek` `qq-bot` `onebot` `snowluma` `windows`
2. 在 README 顶部放一张群聊截图（`assets/` 下已有 `deepseek娘.png`，截图建议自己录）
3. Release 里挂演示视频（10MB 以内的 mp4 可以直接拖进 Release 附件）
4. 贴吧/群里发帖时用 `docs/DEMO.md` 底部的配文
