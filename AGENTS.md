# Agent rules

Rules for any AI agent working in this repository.

## Branches and git

- Only use the `master` branch for all work. Use another branch only when specifically asked to.
- When a git sync happens, create a git commit and also push the code. Keep the commit message
  short, in American slang and not technical, so it reads as if a human wrote it.

## Making changes

- Always restart the app after a code change and verify it restarts successfully.
- Treat compile warnings as errors and make sure they are fixed.
- Do not run all tests after a code change. Run only the tests related to the change, or no tests
  at all if the change is simple.
- Do not use `dotnet user-secrets` to store data locally. Put it in `appsettings` or in Azure Key
  Vault (if one exists).
- Avoid making the user type commands into the CLI or click through a web GUI by hand when you can
  do it for them automatically.

## Finding your way

- Check for a `DOCS` folder in the repository root to get an overall summary of the project.

## Reporting back

- At the end of any answer longer than 100 words, add a TLDR summary of about 20 words.
- If more than 100 lines of code are removed overall in one prompt, mention it.
- When a change to the UI is made, take an annotated screenshot showing the old and the new UI
  with the changes marked. Place the image in the `SCREENSHOTS` folder inside an HTML file and
  give its valid full path.
