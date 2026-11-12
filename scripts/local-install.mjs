#!/usr/bin/env node
/**
 * Install the panel from a `main`-branch tarball into the local desktop profile.
 *
 *   node scripts/local-install.mjs                  # pack the current version, install it, update profile dependency
 *   node scripts/local-install.mjs --dry-run        # validate and print the plan; writes nothing
 *   node scripts/local-install.mjs --verify         # read-only check of the current install
 *   node scripts/local-install.mjs --tarball ../releases/x.tgz --profile-dir ~/.dsh/profiles/desktop
 *
 * The install state is a real directory unpacked from `<repo>/../releases/<name>-<version>.tgz`, with the
 * profile dependency pointing at that tarball as `file:<absolute path>`. This script only writes inside the
 * profile directory (its package.json, its backup, and the package directory); it never calls the panel,
 * restarts DSH, or touches live.json.
 */
import { spawnSync } from 'node:child_process'
import {
  copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync,
  renameSync, rmSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PREFIX = '[local-install]'
const USAGE = `用法：node scripts/local-install.mjs [选项]

把当前仓库（main 分支）的打包产物安装到桌面 profile：
  --tarball <path>      指定 .tgz（默认：仓库同级 releases/<name>-<version>.tgz）
  --profile-dir <path>  profile 目录（默认：$DSH_HOME/profiles/desktop，通常 ~/.dsh/profiles/desktop）
  --dry-run             只校验并打印计划，不写盘
  --verify              只读核对当前安装态（包目录版本 + dependency 是否指向 tarball）
  --allow-branch        允许不在 main 分支时安装（默认拒绝）
  -h, --help            显示本帮助

安装会：备份 profile/package.json → 解包 tarball 到 profile/node_modules/<name> → 把 dependency 改为
file:<tarball 绝对路径>。只写 profile 目录，不调用面板、不重启 DSH、不改 live.json。`

class LocalInstallError extends Error {}

const fail = message => { throw new LocalInstallError(message) }
const log = line => console.log(`${PREFIX} ${line}`)

function expandHome(value) {
  if (value === '~') return homedir()
  if (value.startsWith('~/')) return join(homedir(), value.slice(2))
  return value
}

function statSafe(path) {
  try { return statSync(path) } catch { return undefined }
}

function lstatSafe(path) {
  try { return lstatSync(path) } catch { return undefined }
}

function readJson(path, label = path) {
  let raw = ''
  try { raw = readFileSync(path, 'utf8') } catch (error) {
    fail(`读取 ${label} 失败：${error.message}`)
  }
  try { return JSON.parse(raw) } catch {
    fail(`${label} 不是合法 JSON`)
  }
}

function git(args) {
  const result = spawnSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' })
  if (result.error) fail(`无法运行 git：${result.error.message}`)
  if (result.status !== 0) fail(`git ${args.join(' ')} 失败：${(result.stderr || '').trim()}`)
  return result.stdout.trim()
}

function packageDirFor(profileDir, packageName) {
  return join(profileDir, 'node_modules', ...packageName.split('/'))
}

function timestamp() {
  const now = new Date()
  const pad = value => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-`
    + `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

function parseArgs(argv) {
  const options = {
    tarball: undefined, profileDir: undefined, dryRun: false, verify: false, allowBranch: false, help: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') { options.help = true; continue }
    if (arg === '--dry-run') { options.dryRun = true; continue }
    if (arg === '--verify') { options.verify = true; continue }
    if (arg === '--allow-branch') { options.allowBranch = true; continue }
    if (arg === '--tarball' || arg === '--profile-dir') {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) fail(`${arg} 需要一个路径参数`)
      options[arg === '--tarball' ? 'tarball' : 'profileDir'] = value
      index += 1
      continue
    }
    if (arg.startsWith('--tarball=')) { options.tarball = arg.slice('--tarball='.length); continue }
    if (arg.startsWith('--profile-dir=')) { options.profileDir = arg.slice('--profile-dir='.length); continue }
    fail(`未知参数：${arg}（--help 查看用法）`)
  }
  if (options.verify && options.dryRun) fail('--verify 与 --dry-run 不能同时使用')
  return options
}

function defaultTarball(repoPkg) {
  const releasesDir = join(repoRoot, '..', 'releases')
  const baseName = repoPkg.name.includes('/') ? repoPkg.name.split('/').pop() : repoPkg.name
  const expected = join(releasesDir, `${baseName}-${repoPkg.version}.tgz`)
  if (existsSync(expected)) return expected
  if (existsSync(releasesDir)) {
    const candidates = readdirSync(releasesDir)
      .filter(name => name.startsWith(`${baseName}-`) && name.endsWith(`-${repoPkg.version}.tgz`))
      .sort()
    if (candidates.length > 0) return join(releasesDir, candidates[candidates.length - 1])
  }
  return expected
}

function readTarballPackage(tarball) {
  const result = spawnSync('tar', ['-xzOf', tarball, 'package/package.json'],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  if (result.error) fail(`无法运行 tar：${result.error.message}`)
  if (result.status !== 0) {
    fail(`读取 tarball 内 package/package.json 失败（tar exit ${result.status}）：${(result.stderr || '').trim()}`)
  }
  try { return JSON.parse(result.stdout) } catch { fail('tarball 内 package/package.json 不是合法 JSON') }
}

function extractTarball(tarball, destination) {
  const result = spawnSync('tar', ['-xzf', tarball, '-C', destination, '--strip-components=1'],
    { encoding: 'utf8' })
  if (result.error) fail(`无法运行 tar：${result.error.message}`)
  if (result.status !== 0) {
    fail(`解包 tarball 失败（tar exit ${result.status}）：${(result.stderr || '').trim()}`)
  }
}

function assertSafeEntries(tarball) {
  const result = spawnSync('tar', ['-tzf', tarball], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  if (result.error) fail(`无法运行 tar：${result.error.message}`)
  if (result.status !== 0) {
    fail(`读取 tarball 文件列表失败（tar exit ${result.status}）：${(result.stderr || '').trim()}`)
  }
  const unsafe = []
  for (const raw of result.stdout.split('\n')) {
    const entry = raw.trim().replace(/\\/g, '/')
    if (!entry) continue
    if (entry === 'package' || entry === 'package/') continue
    if (!entry.startsWith('package/') || isAbsolute(entry)) { unsafe.push(entry); continue }
    const rest = entry.slice('package/'.length)
    if (rest.split('/').some(part => part === '..')) unsafe.push(entry)
  }
  if (unsafe.length > 0) {
    fail(`tarball 含不安全路径（只允许 package/ 下的相对路径）：${unsafe.slice(0, 3).join('、')}`)
  }
}

function validateTarball(tarball, repoPkg) {
  const info = statSafe(tarball)
  if (!info) {
    fail(`tarball 不存在：${tarball}\n  先在本仓库 main 分支执行：npm pack --pack-destination ../releases`)
  }
  if (!info.isFile()) fail(`tarball 不是文件：${tarball}`)
  assertSafeEntries(tarball)
  const tarballPkg = readTarballPackage(tarball)
  if (tarballPkg.name !== repoPkg.name) {
    fail(`tarball 包名 ${tarballPkg.name} 与仓库 ${repoPkg.name} 不一致`)
  }
  if (tarballPkg.version !== repoPkg.version) {
    fail(`tarball 版本 ${tarballPkg.version} 与仓库 ${repoPkg.version} 不一致；先重新 npm pack`)
  }
  log(`tarball：${tarball}（${tarballPkg.name}@${tarballPkg.version}）`)
  return tarballPkg
}

function validateProfile(profileDir) {
  const info = statSafe(profileDir)
  if (!info) fail(`profile 目录不存在：${profileDir}`)
  if (!info.isDirectory()) fail(`profile 路径不是目录：${profileDir}`)
  const pkgFile = join(profileDir, 'package.json')
  if (!existsSync(pkgFile)) fail(`profile 缺少 package.json：${pkgFile}`)
  return readJson(pkgFile, `${profileDir}/package.json`)
}

function resolveTarball(options, repoPkg) {
  const raw = options.tarball ? expandHome(options.tarball) : defaultTarball(repoPkg)
  return isAbsolute(raw) ? resolve(raw) : resolve(process.cwd(), raw)
}

function resolveDependencyTarball(profileDir, dependency) {
  const raw = expandHome(String(dependency).slice('file:'.length))
  return isAbsolute(raw) ? resolve(raw) : resolve(profileDir, raw)
}

function timestampedBackup(profileDir) {
  const base = join(profileDir, `package.json.bak-local-install-${timestamp()}`)
  let candidate = base
  let suffix = 2
  while (existsSync(candidate)) {
    candidate = `${base}-${suffix}`
    suffix += 1
  }
  return candidate
}

function updateDependency(profileDir, packageName, tarball) {
  const file = join(profileDir, 'package.json')
  const profilePkg = readJson(file, `${profileDir}/package.json`)
  const dependencies = profilePkg.dependencies && typeof profilePkg.dependencies === 'object'
    ? profilePkg.dependencies
    : (profilePkg.dependencies = {})
  const before = dependencies[packageName]
  dependencies[packageName] = `file:${tarball}`
  writeFileSync(file, `${JSON.stringify(profilePkg, null, 2)}\n`)
  log(`dependency：${before ?? '(无)'} → file:${tarball}`)
}

function verifyInstall(profileDir, packageName, repoPkg) {
  log('验证安装态（只读）')
  log(`profile：${profileDir}`)

  const profilePkg = validateProfile(profileDir)
  const problems = []
  let tarballVersion
  const dependency = profilePkg.dependencies?.[packageName]
  if (!dependency) {
    problems.push(`profile package.json 里没有 ${packageName} 依赖`)
  } else if (!String(dependency).startsWith('file:')) {
    log(`dependency：${dependency}（不是 file:<tarball>）`)
    problems.push(`profile dependency 不是 file:<tarball>：${dependency}`)
  } else {
    const tarball = resolveDependencyTarball(profileDir, dependency)
    log(`dependency：file:${tarball}`)
    if (!existsSync(tarball)) {
      problems.push(`dependency 指向的 tarball 不存在：${tarball}`)
    } else {
      const tarballPkg = readTarballPackage(tarball)
      tarballVersion = tarballPkg.version
      log(`tarball：${tarball}（${tarballPkg.name}@${tarballPkg.version}）`)
      if (tarballPkg.name !== packageName) {
        problems.push(`tarball 包名 ${tarballPkg.name} 与 ${packageName} 不一致`)
      }
    }
  }

  const target = packageDirFor(profileDir, packageName)
  const targetInfo = lstatSafe(target)
  let installedPkg
  if (!targetInfo) {
    problems.push(`安装目录不存在：${target}`)
  } else if (targetInfo.isSymbolicLink()) {
    log(`包目录：symlink → ${readlinkSafe(target)}（应为实体目录）`)
    problems.push(`包目录是 symlink，不是 tarball 解包后的实体目录：${target}`)
  } else if (!targetInfo.isDirectory()) {
    problems.push(`包目录不是目录：${target}`)
  } else {
    const installedFile = join(target, 'package.json')
    if (!existsSync(installedFile)) {
      problems.push(`包目录缺少 package.json：${installedFile}`)
    } else {
      installedPkg = readJson(installedFile, `${target}/package.json`)
      log(`包目录：实体目录 ${target}（${installedPkg.name}@${installedPkg.version}）`)
      if (installedPkg.name !== packageName) {
        problems.push(`已安装包名 ${installedPkg.name} 与 ${packageName} 不一致`)
      }
    }
  }

  if (installedPkg && tarballVersion && installedPkg.version !== tarballVersion) {
    problems.push(`已安装版本 ${installedPkg.version} 与 dependency 指向的 tarball ${tarballVersion} 不一致`)
  }
  if (installedPkg && installedPkg.version !== repoPkg.version) {
    log(`提示：仓库版本 ${repoPkg.version} 与已安装 ${installedPkg.version} 不同；`
      + '需要显式打包安装后运行态才更新（本检查只读）')
  }

  if (problems.length > 0) {
    for (const problem of problems) console.error(`${PREFIX} ✗ ${problem}`)
    fail('当前安装态不符合 main 打包产物模型')
  }
  log('结论：安装态符合 main 打包产物模型（dependency 为 file:<tarball>，包目录为实体目录）。')
}

function readlinkSafe(path) {
  try { return readlinkSync(path) } catch { return '?' }
}

function dryRun({ profileDir, tarball, tarballPkg, repoPkg }) {
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'])
  const dirty = git(['status', '--porcelain'])
  if (branch !== 'main') log(`注意：当前分支是 ${branch}，不是 main（--dry-run 不阻止）`)
  if (dirty) log('注意：工作树不干净（--dry-run 不阻止）')

  const target = packageDirFor(profileDir, repoPkg.name)
  const backup = join(profileDir, `package.json.bak-local-install-${timestamp()}`)
  log('dry run：以下动作不会执行，不会写盘。')
  log(`1) 备份 ${join(profileDir, 'package.json')} → ${backup}`)
  log(`2) 解包 ${tarball} → 临时目录并校验 ${tarballPkg.name}@${tarballPkg.version}`)
  log(`3) 删除旧包目录或 symlink（若存在）：${target}`)
  log(`4) 安装到包目录：${target}`)
  log(`5) 修改 profile dependency：${repoPkg.name} = "file:${tarball}"`)
  log('下一步：在面板「插件管理」里重载该插件，然后刷新页面。')
  log('dry run 结束：未写任何文件。')
}

function install({ profileDir, tarball, repoPkg, allowBranch }) {
  const packageName = repoPkg.name
  const target = packageDirFor(profileDir, packageName)
  const profilePkgFile = join(profileDir, 'package.json')

  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'])
  if (branch !== 'main') {
    if (!allowBranch) fail(`当前分支是 ${branch}，不是 main；安装打包必须来自 main（或加 --allow-branch）`)
    log(`警告：当前分支是 ${branch}，不是 main（--allow-branch 已放宽）`)
  }
  const dirty = git(['status', '--porcelain'])
  if (dirty) fail('工作树不干净；先提交或清理，再打包安装（tarball 必须反映 main）')

  const backup = timestampedBackup(profileDir)
  copyFileSync(profilePkgFile, backup)
  log(`备份 profile package.json → ${backup}`)

  const staging = mkdtempSync(join(profileDir, '.local-install-'))
  let moved = false
  try {
    log(`解包 tarball → 临时目录 ${staging}`)
    extractTarball(tarball, staging)
    const stagedPkg = readJson(join(staging, 'package.json'), 'tarball 内 package/package.json')
    if (stagedPkg.name !== packageName) {
      fail(`tarball 内包名 ${stagedPkg.name} 与仓库 ${packageName} 不一致`)
    }
    if (stagedPkg.version !== repoPkg.version) {
      fail(`tarball 内版本 ${stagedPkg.version} 与仓库 ${repoPkg.version} 不一致`)
    }

    mkdirSync(dirname(target), { recursive: true })
    const targetInfo = lstatSafe(target)
    if (!targetInfo) {
      log(`旧包目录不存在，跳过删除：${target}`)
    } else if (targetInfo.isSymbolicLink()) {
      log(`删除旧 link：${target} → ${readlinkSafe(target)}`)
      unlinkSync(target)
    } else if (targetInfo.isDirectory()) {
      log(`删除旧包目录：${target}`)
      rmSync(target, { recursive: true, force: true })
    } else {
      fail(`目标路径既不是目录也不是 symlink：${target}`)
    }

    renameSync(staging, target)
    moved = true
    log(`安装包目录 → ${target}（${stagedPkg.name}@${stagedPkg.version}）`)
  } finally {
    if (!moved) rmSync(staging, { recursive: true, force: true })
  }

  updateDependency(profileDir, packageName, tarball)

  log(`安装完成：${packageName}@${repoPkg.version}`)
  log(`profile：${profileDir}`)
  log(`备份：${backup}`)
  log('未触碰 live.json、未调用面板、未重启 DSH。')
  log('下一步：')
  log('  1. 打开面板 → 插件管理（Plugin Manager），重载该插件（或禁用→启用）')
  log('  2. 刷新页面，确认左侧栏「超级智能体」入口与版本')
  log(`  3. 回滚：cp "${backup}" "${profilePkgFile}"，再把旧 tarball 解包回包目录后重载插件`)
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(USAGE)
    return
  }
  if (Number(process.versions.node.split('.')[0]) < 18) {
    fail(`需要 Node.js 18+（当前 ${process.version}）`)
  }

  const repoPkg = readJson(join(repoRoot, 'package.json'), `${repoRoot}/package.json`)
  if (!repoPkg.name || !repoPkg.version) fail('仓库 package.json 缺少 name/version')
  log(`仓库：${repoRoot}（${repoPkg.name}@${repoPkg.version}）`)

  const profileDir = resolve(expandHome(options.profileDir
    ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', 'desktop')))
  const tarball = resolveTarball(options, repoPkg)

  if (options.verify) {
    verifyInstall(profileDir, repoPkg.name, repoPkg)
    return
  }

  validateTarball(tarball, repoPkg)
  validateProfile(profileDir)

  if (options.dryRun) {
    dryRun({ profileDir, tarball, tarballPkg: readTarballPackage(tarball), repoPkg })
    return
  }

  install({ profileDir, tarball, repoPkg, allowBranch: options.allowBranch })
}

try {
  main()
} catch (error) {
  console.error(`${PREFIX} 错误：${error instanceof LocalInstallError ? error.message : error?.stack ?? error}`)
  console.error(`${PREFIX} 已停止；未触碰 live.json 与 DSH 进程。若此前已备份，profile 的 package.json 备份保留在 profile 目录。`)
  process.exitCode = 1
}
