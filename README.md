# YouTube Preview Scene Assessment

The extension checks whether sampled preview frames appear to match a video's title. It does not determine whether the video or its factual claims are true.

## Optional fact-check reference search

The local Node backend searches Google's Fact Check Tools API for reviews related to the YouTube title. Search matches are references only: they are not proof that the video makes the same claim or that its content is true. The current version does not retrieve video transcripts or independently extract and verify claims.

1. Enable the Fact Check Tools API for a Google Cloud project and create an API key.
2. Open `.env` and set `GOOGLE_FACT_CHECK_API_KEY=your_key`. Keep the key private; `.env` is excluded by `.gitignore` and must never be added to extension files.
3. From this folder, run `npm start`.
4. Reload the unpacked extension in Chrome and open YouTube.

The backend binds only to `127.0.0.1:3000`. If it is stopped or the API key is missing, the extension reports that fact-check search is unavailable and continues to abstain on factual truth.
