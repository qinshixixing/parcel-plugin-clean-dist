# Changelog

## Unreleased

- Resolve symlinks before deciding whether an output directory is safe to clean. A link to the project root, the filesystem root, or a directory outside the project is left untouched.
- Clean each target directory once. Cleaning a parent no longer walks into a nested target, and it no longer deletes a nested target that is a symlink.
- Ignore a file that disappears between the directory listing and the delete.

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
