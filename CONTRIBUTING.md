# Contributing to PixelCI

Thanks for your interest in improving PixelCI.

## Where to Contribute

- **Bugs and feature requests:** open an issue on [GitHub](https://github.com/zyno-io/pixelci/issues).
- **Code and documentation:** open a pull request against `main` on [github.com/zyno-io/pixelci](https://github.com/zyno-io/pixelci). For anything larger than a small fix, please open an issue first so we can agree on the approach.

The GitHub repository is a mirror of our primary repository. A maintainer may apply an accepted pull request there rather than merging it on GitHub, in which case your pull request is closed once the change appears on `main`.

## Contributor License Agreement

Before we can accept a contribution, you need to sign the [PixelCI Contributor License Agreement](CLA.md). You keep the copyright in your contribution; the CLA gives Signal24 LLC dba Zyno Consulting the right to ship it in PixelCI, in its hosted services, and under commercial licenses.

- **Individuals:** when you open your first pull request, the CLA bot will ask you to post this comment on it:

    > I have read the CLA Document and I hereby sign the CLA

    You only need to do this once. If the check does not update, comment `recheck`.

- **Companies:** if you contribute as part of your job, have an authorized representative complete Part B of the [CLA](CLA.md) and email it to support@sgnl24.com. Each contributor still signs individually with the comment above.

Every commit in the pull request must be authored by a GitHub account that has signed.

## License

PixelCI is source-available, under the [PixelCI Source Available License, Version 1.1](LICENSE.md). In short:

- Self-hosting PixelCI for your organization's internal use is free.
- Offering PixelCI as a hosted or managed service, embedding it in a product, distributing it, or white-labelling it requires a commercial license.
- You may fork the repository and modify PixelCI to prepare and submit a contribution (Section 8 of the License).

The License itself is the authoritative text. Contributions you submit are covered by Section 8 of the License and by the CLA.

## Development Setup

See the [Development Guide](DEVELOPMENT.md) for prerequisites, local services, running the API and UI, and running tests. Before opening a pull request:

- run `yarn format`;
- run the tests relevant to your change (see the Development Guide);
- add a line to the `Unreleased` section of [CHANGELOG.md](CHANGELOG.md) for user-visible changes.
