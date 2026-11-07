# Changelog

## 1.0.2

- Delete stale files in parallel, and walk a nested target directory only as part of its parent.
- When an `exclude` pattern covers a whole directory, such as `static/**`, list that directory once instead of matching every nested file.
- Refuse to clean an output directory that is a symbolic link, or that is reached through one, instead of following the link.

## 1.0.1

- Keep the output directory of a target when it becomes empty instead of deleting it. Nested target directories were removed by the parent's empty-directory cleanup.
- Treat only a leading `..` segment as leaving a directory. A name like `..backup` stays inside the project, and `exclude` patterns such as `..assets/**` now apply.
- Compile `exclude` globs once per build instead of once per file and pattern.
- Read directory entries with their file type and skip the `lstat` per entry; remove empty directories without a second `readdir`.
- Make the integration tests independent of Parcel's incremental cache, which could reuse a previous build and fail intermittently.
- Test on Node 18, 20, 22, and 24. Require Node 18 or newer.

## 1.0.0

This release targets Parcel 2. Parcel 1 projects should stay on 0.0.6.

- Rewrite the plugin as a Parcel Reporter and require it from `.parcelrc`.
- After a successful production build, delete output files that are not part of that build.
- Keep bundle files together with `.map`, `.gz`, and `.br` siblings.
- Leave watch mode and `parcel serve` unchanged unless `watch` is enabled.
- Skip cleaning when a build fails.
- Refuse to clean the project root, the filesystem root, or a directory outside the project.
- Read `exclude` and `watch` from the `parcel-plugin-clean-dist` field in package.json.
- Add an MIT license.
