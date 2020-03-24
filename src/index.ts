import { Application, Context } from 'probot';
import child_process from 'child_process';
import { promises as fs } from 'fs';
import { promisify } from 'util';
import tmp from 'tmp-promise';

const exec = promisify(child_process.exec);

async function handle_pr(context: Context) {
  const { owner, repo } = context.repo();

  const pr_number = context.payload.pull_request.number;

  context.log(`handling PR #${pr_number} for ${owner}/${repo}`);

  const head_sha = context.payload.pull_request.head.sha;

  // github api lies about base sha, so we pull it from the first commit's parent
  const commits = await context.github.pullRequests.listCommits(context.repo({number: pr_number}));
  const base_sha = commits.data[0].parents[0].sha;

  const base_file = await tmp.file();
  const head_file = await tmp.file();

  // create the repo clone
  const path = `repos/${owner}/${repo}`;
  try {
    await fs.access(path);
  } catch (e) {
    await fs.mkdir(path, { recursive: true });
    await exec(`git clone https://github.com/${owner}/${repo} ${path}`);
  }

  // fetch the latest refs
  // note: we pass the shas directly, as PR shas aren't fetched by default
  await exec(`git fetch origin ${base_sha} ${head_sha}`, { cwd: path });

  // grab the metadata for base
  await exec(`git checkout --force ${base_sha}`, { cwd: path });
  const { stdout: base_stdout } = await exec("cargo metadata --format-version 1",
                                             { cwd: path, maxBuffer: 10 * 1024 * 1024 });
  await fs.writeFile(base_file.path, base_stdout);

  // grab the metadata for head
  await exec(`git checkout --force ${head_sha}`, { cwd: path });
  const { stdout: head_stdout } = await exec("cargo metadata --format-version 1",
                                             { cwd: path, maxBuffer: 10 * 1024 * 1024 });
  await fs.writeFile(head_file.path, head_stdout);

  // run cargo guppy diff
  const { stdout } = await exec(`cargo guppy diff ${base_file.path} ${head_file.path}`);
  const text_output = stdout.toString();

  if (text_output.length > 0) {
    // build comment
    const text = '```markdown\n' + text_output + '\n```';
    const body = `This PR made the following dependency changes:\n\n${text}\n`;

    // search for and delete any older comments the bot left
    const comments = await context.github.issues.listComments(context.repo({number: pr_number}));
    for (let comment of comments.data) {
      if (comment.user.login === "cargo-dep-bot[bot]") {
        await context.github.issues.deleteComment(context.repo({comment_id: comment.id}));
      }
    }

    // report the analysis in a comment
    await context.github.issues.createComment(context.repo({number: pr_number, body: body}));
  }

  base_file.cleanup();
  head_file.cleanup();
}

export = (app: Application) => {
  app.on('pull_request.opened', async (context: Context) => {
    context.log("pull request opened");
    await handle_pr(context);
  });

  app.on('pull_request.synchronize', async (context: Context) => {
    context.log("pull request synchronize");
    await handle_pr(context);
  });
}
