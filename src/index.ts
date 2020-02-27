import { Application, Context } from 'probot';
import child_process from 'child_process';
import { promises as fs } from 'fs';
import { promisify } from 'util';
import tmp from 'tmp-promise';

const exec = promisify(child_process.exec);

async function handle_pr(context: Context) {
  context.log("handling PR");
  const pr_number = context.payload.pull_request.number;

  const head_sha = context.payload.pull_request.head.sha;

  // github api lies about base sha, so we pull it from the first commit's parent
  const commits = await context.github.pullRequests.listCommits(context.repo({number: pr_number}));
  const commit_ref = commits.data[0].sha;
  const commit = await context.github.repos.getCommit(context.repo({sha: commit_ref}));
  const base_sha = commit.data.parents[0].sha;

  const base_lock_params = context.repo({ref: base_sha, path: 'Cargo.lock'});

  const head_lock_params = context.repo({ref: head_sha, path: 'Cargo.lock'});
  const base_content_encoded = await context.github.repos.getContents(base_lock_params);
  const base_content = Buffer.from(base_content_encoded.data.content, 'base64').toString()
  const head_content_encoded = await context.github.repos.getContents(head_lock_params);
  const head_content = Buffer.from(head_content_encoded.data.content, 'base64').toString()

  const base_file = await tmp.file();
  const head_file = await tmp.file();

  await fs.writeFile(base_file.fd, base_content);
  await fs.writeFile(head_file.fd, head_content);

  const { stdout, stderr } = await exec(`cargo lockfile diff ${base_file.path} ${head_file.path}`);
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
