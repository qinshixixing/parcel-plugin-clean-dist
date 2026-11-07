# parcel-plugin-clean-dist

Parcel 2 reporter that deletes stale files from each target output directory after a successful production build.

Parcel keeps previous content-hashed files on disk. This plugin compares the finished bundle graph with the output directory and removes files that the build did not emit.

## Install

```bash
npm install -D parcel-plugin-clean-dist
```

Parcel 2 does not enable installed plugins on its own. Add the reporter to `.parcelrc` and keep the default reporters with `"..."`:

```json
{
  "extends": "@parcel/config-default",
  "reporters": ["...", "parcel-plugin-clean-dist"]
}
```

Put this reporter before any reporter that copies extra files into the output directory. Reporters run in listed order after `buildSuccess`. This one removes files that are not in the bundle graph, then a later reporter can write static files into the cleaned directory.

## Behavior

On `buildSuccess` in production (`parcel build`):

- Each target `distDir` is cleaned separately. A parent directory does not walk into a nested target, and it does not delete a nested target that is a symlink.
- Files emitted by the build are kept, including `.map`, `.gz`, and `.br` siblings.
- Other files in those directories are deleted.
- Directories that become empty are deleted. The output directory itself stays.
- A failed build does not delete anything.
- `parcel watch` and `parcel serve` do not delete anything unless `watch` is true.
- A directory is left untouched when it is the project root, the filesystem root, or outside the project. Symlinks are resolved before that check, so an output path inside the project that points outside is left untouched too. Parcel reports that refusal as an error.

## Configuration

Optional settings live under the package name in the project's `package.json`. Patterns are relative to each target output directory.

```json
{
  "parcel-plugin-clean-dist": {
    "watch": false,
    "exclude": ["static/**", "**/.gitkeep"]
  }
}
```

| Field | Default | Description |
| --- | --- | --- |
| `watch` | `false` | Also clean after successful non-production builds. |
| `exclude` | `[]` | Globs for files that must be kept. `**` matches nested paths, including dotfiles. |

## Parcel 1

`1.x` supports Parcel `2.x` only. Projects still using Parcel 1 should install the previous release:

```bash
npm install -D parcel-plugin-clean-dist@0.0.6
```

## 中文

`1.0.0` 只支持 Parcel 2。生产构建成功后，插件会删掉每个 target 输出目录里不属于这次构建的文件。`parcel watch` 和 `parcel serve` 默认不清理。输出目录如果是指向项目外的符号链接，插件不会清理它。还在用 Parcel 1 的项目请锁定 `0.0.6`。

在 `.parcelrc` 的 `reporters` 中加入 `parcel-plugin-clean-dist`，并保留 `"..."`。需要跳过的文件写在 `package.json` 的 `parcel-plugin-clean-dist.exclude` 里，路径相对于每个输出目录。
