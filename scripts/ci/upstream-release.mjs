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

async function git(cwd, args) {
  const result = await exec("git", args, { cwd, maxBuffer: 128 * 1024 * 1024 });
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
  await output({ tag, upstream, fork, node });
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
  const [command, directory, tag] = process.argv.slice(2);
  if (command === "sync" && directory) return syncSource(directory);
  if (command === "validate" && directory && tag) {
    const { parse } = await import("yaml");
    const manifest = parse(await readFile(resolve(directory, "latest.yml"), "utf8"));
    const assets = await validateManifest(directory, manifest, tag);
    await writeFile(resolve(directory, "release-assets.txt"), assets.join("\n") + "\n");
    return;
  }
  throw new Error("Usage: upstream-release.mjs sync <worktree> | validate <dist> <tag>");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
