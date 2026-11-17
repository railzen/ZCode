import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { appendFile, readFile, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const exec = promisify(execFile);
const stableTag = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function selectLatestTag(tags) {
  const stable = tags.filter((tag) => stableTag.test(tag));
  stable.sort((a, b) => {
    const left = a.match(stableTag).slice(1).map(BigInt);
    const right = b.match(stableTag).slice(1).map(BigInt);
    for (let i = 0; i < 3; i++) {
      if (left[i] !== right[i]) return left[i] > right[i] ? -1 : 1;
    }
    return a.localeCompare(b);
  });
  if (!stable.length) throw new Error("No stable upstream tag found");
  return stable[0];
}

export function makeForkPatchArgs(base, fork) {
  return ["diff", "--binary", "--full-index", base, fork, "--", ".", ":(exclude).github"];
}

async function git(cwd, args, env = process.env) {
  const result = await exec("git", args, { cwd, env, maxBuffer: 128 * 1024 * 1024 });
  return result.stdout;
}

async function output(values) {
  if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required");
  await appendFile(process.env.GITHUB_OUTPUT,
    Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(""));
}

export async function applyForkChanges({ root, source, base, fork, upstream, patchPath }) {
  const patch = await git(root, makeForkPatchArgs(base, fork));
  await git(root, ["worktree", "add", "--detach", source, upstream]);
  if (patch) {
    await writeFile(patchPath, patch);
    // 三方应用保留 fork 定制；冲突必须显式失败，不能回退为纯上游构建。
    await git(source, ["apply", "--3way", "--index", patchPath]);
  }
  // 构建目录以后会推回 main，不能把上游工作流覆盖到 fork 的发布工作流上。
  await git(source, ["restore", `--source=${fork}`, "--staged", "--worktree", "--", ".github"]);
}

export async function snapshotSource({ source, fork, upstream, tag }) {
  if (!stableTag.test(tag)) throw new Error("Invalid stable release tag");
  // 必须在安装与编译前固定源码；后续构建生成的文件不进入同步提交。
  await git(source, ["add", "--update"]);
  const tree = (await git(source, ["write-tree"])).trim();
  const forkTree = (await git(source, ["rev-parse", `${fork}^{tree}`])).trim();
  const containsUpstream = await git(source, ["merge-base", "--is-ancestor", upstream, fork])
    .then(() => true, () => false);
  if (tree === forkTree && containsUpstream) {
    await git(source, ["checkout", "--detach", fork]);
    return fork;
  }
  const parents = ["-p", fork, ...(!containsUpstream ? ["-p", upstream] : [])];
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "github-actions[bot]",
    GIT_AUTHOR_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com",
    GIT_COMMITTER_NAME: "github-actions[bot]",
    GIT_COMMITTER_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com",
  };
  const commit = (await git(source, ["-c", "commit.gpgsign=false", "commit-tree", tree,
    ...parents, "-m", `Sync upstream ${tag} and retain fork customizations`], env)).trim();
  await git(source, ["checkout", "--detach", commit]);
  return commit;
}

export async function pushVerifiedSource({ source, fork, commit, tag, published = false,
  remote = "origin" }) {
  if (!stableTag.test(tag)) throw new Error("Invalid stable release tag");
  await git(source, ["merge-base", "--is-ancestor", fork, commit]);
  const env = { ...process.env };
  if (env.GH_TOKEN) {
    // 凭据仅传给 Git 子进程，不写入磁盘或命令行参数。
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = "http.https://github.com/.extraheader";
    env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${env.GH_TOKEN}`).toString("base64")}`;
  }
  const refs = await git(source, ["ls-remote", remote, "refs/heads/main", `refs/tags/${tag}`], env);
  const refMap = new Map(refs.trim().split(/\r?\n/).filter(Boolean).map((line) => {
    const [sha, name] = line.split(/\s+/);
    return [name, sha];
  }));
  const current = refMap.get("refs/heads/main");
  if (current !== fork && current !== commit) {
    throw new Error("main changed during the build; rerun with the latest main");
  }
  const existingTag = refMap.get(`refs/tags/${tag}`);
  if (!published && existingTag && existingTag !== commit) {
    throw new Error(`Refusing to overwrite existing tag ${tag}`);
  }
  // 先校验祖先关系，再以精确 lease 防止检查后 main 被并发更新；新 tag 一起原子推送。
  await git(source, ["push", "--atomic", `--force-with-lease=refs/heads/main:${current}`,
    remote, `${commit}:refs/heads/main`, ...(!published ? [`${commit}:refs/tags/${tag}`] : [])], env);
}

async function syncSource(destination) {
  const root = process.cwd();
  const source = resolve(destination);
  const fork = (await git(root, ["rev-parse", "HEAD"])).trim();
  const { version } = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  // 上游与 fork 的 tag 必须隔离，避免同名 tag 指向 fork 发布提交，导致定制补丁丢失。
  await git(root, ["fetch", "--no-tags", "https://github.com/zai-org/ZCode.git",
    "+refs/tags/*:refs/upstream-tags/*"]);
  const tags = (await git(root, ["for-each-ref", "--format=%(refname:strip=2)", "refs/upstream-tags/"]))
    .trim().split(/\r?\n/);
  const tag = selectLatestTag(tags);
  const base = tags.find((candidate) => candidate === `v${version}`) ??
    tags.find((candidate) => candidate === version);
  if (!base) throw new Error(`Missing upstream baseline tag for fork version ${version}`);
  const upstream = (await git(root, ["rev-parse", `refs/upstream-tags/${tag}^{commit}`])).trim();
  await applyForkChanges({ root, source, base: `refs/upstream-tags/${base}^{commit}`, fork,
    upstream, patchPath: resolve(process.env.RUNNER_TEMP, "zcode-fork.patch") });
  const pkg = JSON.parse(await readFile(resolve(source, "package.json"), "utf8"));
  if (pkg.version !== tag.replace(/^v/, "")) throw new Error("Synced package version does not match upstream tag");
  const mise = await readFile(resolve(source, "mise.toml"), "utf8");
  const node = mise.match(/^node\s*=\s*"([^"]+)"/m)?.[1];
  if (!node) throw new Error("Missing pinned Node version in mise.toml");
  const synced = await git(root, ["merge-base", "--is-ancestor", upstream, fork])
    .then(() => pkg.version === version, () => false);
  await output({ tag, upstream, fork, node, synced });
}

export async function validateManifest(directory, manifest, tag) {
  if (manifest?.version !== tag.replace(/^v/, "")) throw new Error("Manifest version mismatch");
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) throw new Error("Missing manifest files");
  const assets = [];
  for (const file of manifest.files) {
    if (typeof file.url !== "string" || !/^[\w. -]+\.exe$/.test(file.url)) {
      throw new Error("Update asset must be a relative installer filename");
    }
    const contents = await readFile(resolve(directory, file.url));
    if (createHash("sha512").update(contents).digest("base64") !== file.sha512) {
      throw new Error(`SHA-512 mismatch: ${file.url}`);
    }
    if (contents.length !== file.size) throw new Error(`Installer size mismatch: ${file.url}`);
    const blockmap = `${file.url}.blockmap`;
    const info = await stat(resolve(directory, blockmap)).catch(() => null);
    if (!info?.isFile() || info.size === 0) throw new Error(`Missing blockmap: ${blockmap}`);
    assets.push(file.url, blockmap);
  }
  if (manifest.path !== manifest.files[0].url || manifest.sha512 !== manifest.files[0].sha512) {
    throw new Error("Legacy manifest path/hash mismatch");
  }
  return [...new Set([...assets, "latest.yml"])];
}

async function main() {
  const [command, directory, tag, fork, upstream] = process.argv.slice(2);
  if (command === "sync" && directory) return syncSource(directory);
  if (command === "snapshot" && directory && tag && fork && upstream) {
    const commit = await snapshotSource({ source: resolve(directory), tag, fork, upstream });
    await output({ commit });
    return;
  }
  if (command === "push-verified" && directory && tag && fork && upstream) {
    return pushVerifiedSource({ source: resolve(directory), tag, fork, commit: upstream,
      published: process.env.RELEASE_PUBLISHED === "true" });
  }
  if (command === "validate" && directory && tag) {
    const { parse } = await import("yaml");
    const manifest = parse(await readFile(resolve(directory, "latest.yml"), "utf8"));
    const assets = await validateManifest(directory, manifest, tag);
    await writeFile(resolve(directory, "release-assets.txt"), assets.join("\n") + "\n");
    return;
  }
  throw new Error("Usage: upstream-release.mjs sync <worktree> | snapshot <worktree> <tag> <fork> <upstream> | push-verified <worktree> <tag> <fork> <commit> | validate <dist> <tag>");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
