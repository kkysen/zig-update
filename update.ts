import { assert, assertEquals } from "https://deno.land/std/testing/asserts.ts";
import { encode as encodeToHex } from "https://deno.land/std/encoding/hex.ts";
import * as pathLib from "https://deno.land/std/path/mod.ts";

interface RawArchive {
  tarball: string;
  shasum: string;
  size: string;
}

interface Archive {
  version: string;
  platform: string;
  size: number;
  shasum: string;
  url: URL;
  filePath: string;
  dirPath: string;
  unArchiveCommand: string[];
}

function prepareToUnArchive(path: string): { dir: string; command: string[] } {
  const i = path.lastIndexOf(".tar");
  if (i !== -1) {
    return {
      dir: path.slice(0, i),
      command: ["tar", "xf"],
    };
  }
  const parts = pathLib.parse(path);
  if (parts.ext === ".zip") {
    return {
      dir: parts.name,
      command: ["zip"],
    };
  }
  throw new Error(`unknown archive extension for ${path}`);
}

function archiveFromRaw(
  raw: RawArchive,
  version: string,
  platform: string,
): Archive {
  const { tarball, shasum, size } = raw;
  const url = new URL(tarball);
  const filePath = pathLib.basename(url.pathname);
  const unArchive = prepareToUnArchive(filePath);
  return {
    version,
    platform,
    size: Number(size),
    shasum,
    url,
    filePath,
    dirPath: unArchive.dir,
    unArchiveCommand: unArchive.command,
  };
}

type PlatformName = string;

interface RawRelease extends Record<string, string | undefined | RawArchive> {
  date: string;
  docs: string;
  stdDocs?: string;
  notes?: string;
}

interface ReleaseMeta {
  version: string;
  date: Date;
  docs: URL;
  stdDocs?: URL;
  notes?: URL;
}

interface Release {
  meta: ReleaseMeta;
  platforms: Record<PlatformName, Archive>;
}

type Releases = Record<PlatformName, Release>;

function releaseFromRaw(raw: RawRelease, version: string): Release {
  const { date, docs, stdDocs, notes } = raw;
  const meta = {
    version,
    date: new Date(date),
    docs: new URL(docs),
    stdDocs: stdDocs ? new URL(stdDocs) : undefined,
    notes: notes ? new URL(notes) : undefined,
  };
  const platforms = Object.fromEntries(
    Object.entries(raw)
      .filter((kv): kv is [PlatformName, RawArchive] => {
        const [key, value] = kv;
        return !Object.hasOwn(meta, key) && typeof value === "object";
      })
      .map((
        [platform, rawArchive],
      ) => [platform, archiveFromRaw(rawArchive, version, platform)]),
  );
  return {
    meta,
    platforms,
  };
}

async function downloadReleaseInfo(): Promise<Releases> {
  const response = await fetch("https://ziglang.org/download/index.json");
  const raw = await response.json() as Record<PlatformName, RawRelease>;
  return Object.fromEntries(
    Object.entries(raw)
      .map((
        [version, rawRelease],
      ) => [version, releaseFromRaw(rawRelease, version)]),
  );
}

interface Platform {
  arch: string;
  os: string;
}

async function getCurrentPlatform(): Promise<Platform> {
  let process;
  try {
    process = Deno.run({
      cmd: ["zig", "targets"],
      stdout: "piped",
    });
  } catch (e) {
    if (e.name === "NotFound") {
      return Deno.build;
    } else {
      throw e;
    }
  }
  const stdoutBuffer = await process.output();
  const stdoutString = new TextDecoder().decode(stdoutBuffer);
  const targets = JSON.parse(stdoutString) as {
    native: {
      triple: string;
      cpu: {
        arch: string;
        name: string;
        features: string[];
      };
      os: string;
      abi: string;
    };
  };
  const { native: { cpu: { arch }, os } } = targets;
  return { arch, os };
}

function getReleaseWithVersion(
  releases: Releases,
  version: string | undefined,
): Release {
  return version
    ? releases[version]
    : Object.values(releases).filter((e) => e.meta.version !== "master")[0];
}

async function computeHash(
  buffer: BufferSource,
  algorithm: AlgorithmIdentifier,
): Promise<string> {
  const digest = await crypto.subtle.digest(algorithm, buffer);
  const hex = encodeToHex(new Uint8Array(digest));
  return new TextDecoder().decode(hex);
}

function checkIf<T>(
  log: boolean,
  what: string,
  expected: T,
  actual: T,
  eq: (a: T, b: T) => boolean = (a, b) => a === b,
) {
  const isEq = eq(expected, actual);
  if (!isEq && log) {
    console.log(`${what} does not match: expecting ${expected}, got ${actual}`);
  }
  return isEq;
}

async function checkArchiveBuffer(
  download: Archive,
  buffer: BufferSource,
  { log }: { log: boolean } = { log: false },
): Promise<boolean> {
  return checkIf(log, "archive size", download.size, buffer.byteLength) &&
    checkIf(
      log,
      "archive shasum",
      download.shasum,
      await computeHash(buffer, "sha-256"),
    );
}

async function fetchArchive(
  archive: Archive,
): Promise<ArrayBuffer> {
  console.log(`downloading archive: ${archive.url.href}`);
  const response = await fetch(archive.url.href);
  const buffer = await response.arrayBuffer();
  assert(await checkArchiveBuffer(archive, buffer));
  return buffer;
}

async function saveArchive(archive: Archive) {
  let buffer;
  try {
    buffer = await Deno.readFile(archive.filePath);
  } catch {
    buffer = undefined;
  }
  if (buffer && checkArchiveBuffer(archive, buffer, { log: true })) {
    console.log(`archive already downloaded: ${archive.filePath}`);
    return;
  }
  buffer = await fetchArchive(archive);
  await Deno.writeFile(archive.filePath, new Uint8Array(buffer));
}

function quote(s: string): string {
  return s.includes(" ") ? `'${s}'` : s;
}

async function unpackArchive(archive: Archive) {
  let stats;
  try {
    stats = await Deno.stat(archive.dirPath);
  } catch {
    stats = undefined;
  }
  if (stats?.isDirectory) {
    console.log(`archive already unpacked: ${archive.dirPath}`);
    return;
  }
  const cmd = [...archive.unArchiveCommand, archive.filePath];
  const cmdString = cmd.map(quote).join(" ");
  console.log(`unpacking archive: ${archive.filePath}`);
  console.log(`running: ${cmdString}`);
  const status = await Deno.run({
    cmd,
  }).status();
  if (!status.success) {
    throw new Error(`error running: ${cmdString}`);
  }
}

async function setArchiveToCurrent(archive: Archive) {
  const current = "current";
  let currentLink;
  try {
    currentLink = await Deno.readLink(current);
  } catch {
    currentLink = undefined;
  }
  if (archive.dirPath === currentLink) {
    console.log(`version already set to ${archive.version}`);
  } else {
    console.log(`setting version to ${archive.version}`);
  }
  const tempPath = `${archive.dirPath}.${current}`;
  await Deno.symlink(archive.dirPath, tempPath);
  await Deno.rename(tempPath, current);
}

async function main() {
  const [version] = Deno.args;
  const releases = await downloadReleaseInfo();
  const platform = await getCurrentPlatform();
  const release = getReleaseWithVersion(releases, version);
  const archive = release.platforms[`${platform.arch}-${platform.os}`];
  await saveArchive(archive);
  await unpackArchive(archive);
  await setArchiveToCurrent(archive);
}

await main();