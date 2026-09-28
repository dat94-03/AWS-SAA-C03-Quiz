# SAA Practice

A static, dark-mode quiz for the AWS Certified Solutions Architect Associate (SAA-C03) question bank.

Use the header theme control to switch between Light, Dark, and OLED pure-black themes. Your choice is saved in the current browser.

The bank is split into quizzes of 65 questions, with a question-number jump control. The app saves the active quiz, question, and shuffled order so reloading resumes in the same place.

## Run locally

From PowerShell in this folder:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\run.ps1
```

Open <http://127.0.0.1:4173/>. The bundled question bank loads automatically. Additional DOCX files can be imported from the app.

## Publish with GitHub Pages

1. Create a GitHub repository and push this folder to its `main` or `master` branch.
2. In the repository, open **Settings → Pages** and set the build and deployment source to **GitHub Actions**.
3. Push a commit, or run **Deploy quiz to GitHub Pages** from the repository’s **Actions** tab.
4. Open the Pages URL shown in the workflow deployment summary.

The workflow publishes only `index.html`, `app.js`, `styles.css`, and `questions.json`; the original DOCX documents are not part of the Pages artifact.

**Question bank privacy:** GitHub Pages is a public website for ordinary GitHub repositories. The bundled question text and correct answers are downloaded by visitors and are not secret. Anyone with access to the site can inspect the answers, regardless of whether the GitHub repository itself is private.

The app stores study progress in the current browser. Progress is not synced between devices.