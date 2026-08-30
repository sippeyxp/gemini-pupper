<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

## Documentation

- [Interactive Robot Dog with Gemini Live](docs/interactive-robot-dog.md)
- [System architecture](docs/architecture.md)
- [Robot-side local server](robot/local_server.py)

View your app in AI Studio: https://ai.studio/apps/2d53b29b-b56c-410b-856d-149726bc5d3b

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`

## Deploy to Cloud Run

**Prerequisites:** [Google Cloud SDK](https://cloud.google.com/sdk/docs/install) (`gcloud`) installed and authenticated.

1. Set your GCP project:
   ```bash
   gcloud config set project peng-ttp-test
   ```

2. Deploy (builds the container in the cloud and deploys in one step):
   ```bash
   gcloud run deploy gemini-pupper \
     --project=peng-ttp-test \
     --region=us-central1 \
     --source=. \
     --port=8080 \
     --allow-unauthenticated \
     --memory=256Mi \
     --cpu=1 \
     --min-instances=0 \
     --max-instances=3
   ```

3. The service URL will be printed on success, e.g.:
   ```
   Service URL: https://gemini-pupper-746329146697.us-central1.run.app
   ```

> **Note:** Users must enter their Gemini API key in the Settings panel after opening the app.
