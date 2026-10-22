# HDRJPG convert HDR photos

A GitHub Action that converts the HDR photos in your repository into web-ready HDR files with the
[HDRJPG](https://hdrjpg.com) API, as part of your build.

It takes iPhone HEIC photos, Android Ultra HDR and other gain map JPGs, and EXR files, and writes a gain map JPEG,
an AVIF and a silent HDR MP4 of each one (or any sizes and formats you choose). The files keep the photo's HDR:
they show in HDR on HDR screens and as a normal photo everywhere else. Embed them with the
[HDRJPG markup and hdrjpg-js](https://hdrjpg.com/documentation/embedding) and the photo shows in HDR in
almost every current browser.

Photos already converted with the same settings are skipped, so a run only converts, and only spends
conversions on, new or changed photos. The action keeps track of them in `.hdrjpg-manifest.json` in the
output directory; commit that file together with the converted files.

## Usage

Create an API key at [hdrjpg.com](https://hdrjpg.com/signup) and store it as a repository secret named `HDRJPG_API_KEY`.

```yaml
name: Convert HDR photos
on:
  push:
    paths: ['photos/**']

permissions:
  contents: write

jobs:
  convert:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5

      - uses: hdrjpg/convert-action@v1
        with:
          api-key: ${{ secrets.HDRJPG_API_KEY }}
          source: photos/**/*.{heic,HEIC}
          output-dir: public/hdr

      - name: Commit the converted files
        run: |
          git config user.name github-actions
          git config user.email github-actions@users.noreply.github.com
          git add public/hdr
          git diff --cached --quiet || git commit -m "Convert HDR photos" && git push
```

`photos/2026/sunset.heic` becomes `public/hdr/photos/2026/sunset-1600.jpg`, `sunset-1600.avif` and `sunset-1600.mp4`.

## Inputs

| Input | Default | Description |
|---|---|---|
| `api-key` | (required) | Your HDRJPG API key. Pass it from a secret. |
| `source` | `**/*.{heic,HEIC,exr,EXR}` | Glob patterns of the files to convert, one per line. HEIC, HEIF, JPG, JPEG and EXR files are converted; other matches are ignored. Add JPG patterns only for folders of HDR JPGs. |
| `output-dir` | `hdr` | Where the converted files go. Each photo's files land under its own relative directory. |
| `variants` | 1600 px `jpeg-xt`, `avif` and `mp4` | A JSON array of variants, as in the [API's variant parameter](https://hdrjpg.com/documentation/api). Variants without a `fileName` are named after the photo and the size. |
| `concurrency` | `2` | How many conversions run at once. |
| `poll-interval` | `3` | Seconds between status checks, 2 or more. |
| `timeout` | `600` | Seconds to wait for one conversion. |
| `fail-on-error` | `true` | Fail the step when any photo fails to convert. |

For example, two sizes of each format:

```yaml
          variants: |
            [
              {"width": 2400, "format": "jpeg-xt"},
              {"width": 1200, "format": "jpeg-xt"},
              {"width": 2400, "format": "avif"},
              {"width": 1200, "format": "avif"},
              {"width": 1200, "format": "mp4"}
            ]
```

The free plan allows up to 5 variants per photo, the paid plan up to 15.

## Outputs

| Output | Description |
|---|---|
| `converted` | How many photos were converted in this run. |
| `skipped` | How many photos were already converted with the same variants. |
| `failed` | How many photos failed. |
| `files` | The converted files, one path per line. |

## Pricing

Each photo converted counts as one conversion, whatever the number of variants. The free plan includes
300 conversions a month, with a watermark; the paid plan has no watermark and no cap. See
[hdrjpg.com/pricing](https://hdrjpg.com/pricing).

## Licence

MIT
