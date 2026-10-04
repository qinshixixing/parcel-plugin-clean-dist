# Changelog

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
