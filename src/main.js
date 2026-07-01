import { getInput, getBooleanInput, info as _info, setFailed, setOutput } from '@actions/core';
import { getOctokit, context } from '@actions/github';
import fs from 'fs';
import * as path from 'path';

const requiredArgOptions = {
  required: true,
  trimWhitespace: true
};

const ghToken = getInput('github-token', requiredArgOptions);
const summaryFile = getInput('summary-file', requiredArgOptions);
const reportName = getInput('report-name');
const checkName = getInput('check-name');
const shouldCreateStatusCheck = getBooleanInput('create-status-check');
const shouldCreatePRComment = getBooleanInput('create-pr-comment');
const updateCommentIfOneExists = getBooleanInput('update-comment-if-one-exists');
const ignoreFailures = getBooleanInput('ignore-threshold-failures');
const lineThreshold = parseInt(getInput('line-threshold'));
const branchThreshold = parseInt(getInput('branch-threshold'));

const octokit = getOctokit(ghToken);
const owner = context.repo.owner;
const repo = context.repo.repo;

const jobAndStep = `${process.env.GITHUB_JOB}_${process.env.GITHUB_ACTION}`;
const commentIdentifier = getInput('update-comment-key') || jobAndStep;

function createResultsFile(results, jobAndStep) {
  const resultsFileName = `coverage-results-${jobAndStep}.md`;

  _info(`\nWriting results to ${resultsFileName}`);
  let resultsFilePath = null;

  fs.writeFile(resultsFileName, results, err => {
    if (err) {
      _info(`Error writing results to file. Error: ${err}`);
    } else {
      _info('Successfully created results file.');
      _info(`File: ${resultsFileName}`);
    }
  });
  resultsFilePath = path.resolve(resultsFileName);
  return resultsFilePath;
}

async function lookForExistingComment(octokit, markdownPrefix) {
  let commentId = null;

  await octokit
    .paginate(octokit.rest.issues.listComments, {
      owner,
      repo,
      issue_number: context.payload.pull_request.number
    })
    .then(comments => {
      if (comments.length === 0) {
        _info('There are no comments on the PR.  A new comment will be created.');
      } else {
        const existingComment = comments.find(c => c.body.startsWith(markdownPrefix));
        if (existingComment) {
          _info(`An existing code coverage summary comment (${existingComment.id}) was found and will be updated.`);
          commentId = existingComment.id;
        } else {
          _info('No comments were found.  A new comment will be created.');
        }
      }
    })
    .catch(error => {
      _info(`Failed to list PR comments. Error code: ${error.message}.  A new comment will be created.`);
    });

  _info(`Finished getting comments for PR #${context.payload.pull_request.number}.`);

  return commentId;
}

async function createPrComment(markdown, updateCommentIfOneExists, commentIdentifier) {
  if (context.eventName != 'pull_request') {
    _info('This event was not triggered by a pull_request.  No comment will be created or updated.');
    return;
  }

  const markdownPrefix = `<!-- im-open/process-code-coverage-summary ${commentIdentifier} -->`;
  _info(`The markdown prefix will be: '${markdownPrefix}'`);

  let commentIdToReturn;
  let existingCommentId = null;
  if (updateCommentIfOneExists) {
    _info('Checking for existing comment on PR....');
    existingCommentId = await lookForExistingComment(octokit, markdownPrefix);
  }

  if (existingCommentId) {
    _info(`Updating existing PR #${existingCommentId} comment...`);
    commentIdToReturn = existingCommentId;

    await octokit.rest.issues
      .updateComment({
        owner,
        repo,
        body: `${markdownPrefix}\n${markdown}`,
        comment_id: existingCommentId
      })
      .then(response => {
        _info(`PR comment was updated.  ID: ${response.data.id}.`);
      })
      .catch(error => {
        setFailed(`An error occurred trying to update the PR comment: ${error.message}`);
      });
  } else {
    _info(`Creating a new PR comment...`);
    await octokit.rest.issues
      .createComment({
        owner,
        repo,
        body: `${markdownPrefix}\n${markdown}`,
        issue_number: context.payload.pull_request.number
      })
      .then(response => {
        _info(`PR comment was created.  ID: ${response.data.id}.`);
        commentIdToReturn = response.data.id;
      })
      .catch(error => {
        setFailed(`An error occurred trying to create the PR comment: ${error.message}`);
      });
  }
  return commentIdToReturn;
}

async function createStatusCheck(reportName, checkName, markdown, conclusion) {
  _info(`\nCreating Status check for ${reportName}...`);

  const git_sha = context.eventName === 'pull_request' ? context.payload.pull_request.head.sha : context.sha;
  const name = `status check - ${checkName}`;
  const status = 'completed';
  const checkTime = new Date().toUTCString();
  const summary = `This run completed at \`${checkTime}\``;

  const propMessage = `  Name: ${name}
  GitSha: ${git_sha}
  Event: ${context.eventName}
  Status: ${status}
  Conclusion: ${conclusion}
  Check time: ${checkTime}
  Title: ${reportName}
  Summary: ${summary}`;
  _info(propMessage);

  let statusCheckId;
  await octokit.rest.checks
    .create({
      owner,
      repo,
      name: name,
      head_sha: git_sha,
      status: status,
      conclusion: conclusion,
      output: {
        title: reportName,
        summary: summary,
        text: markdown
      }
    })
    .then(response => {
      _info(`Created check: '${response.data.name}' with id '${response.data.id}'`);
      statusCheckId = response.data.id;
    })
    .catch(error => {
      setFailed(`An error occurred trying to create the status check: ${error.message}`);
    });
  return statusCheckId;
}

function getBadge(conclusion) {
  const badgeStatusText = conclusion === 'success' ? 'PASSED' : 'FAILED';
  const badgeColor = conclusion === 'success' ? 'brightgreen' : 'red';

  return `![Generic badge](https://img.shields.io/badge/${badgeStatusText}-${badgeColor}.svg)`;
}

function getMarkdownFromSummary(summaryInputData, reportName, coverageInfo) {
  const regex = /# Summary/i;
  const markdownDetails = summaryInputData.replace(regex, '');
  const line = coverageInfo.line;
  const branch = coverageInfo.branch;

  const markdown = `# ${reportName}

| Coverage Type | Threshold            | Actual Coverage           |  Status         |
|-------------- |----------------------|---------------------------|-----------------|
| Line          | ${line.threshold}%   | ${line.actualCoverage}%   | ${line.badge}   |
| Branch        | ${branch.threshold}% | ${branch.actualCoverage}% | ${branch.badge} |

## Code Coverage Summary

<details>
<summary>Code Coverage Details</summary>

${markdownDetails.trim()}
</details>
`;
  return markdown;
}

function getIndividualCoverageInfo(summaryInputData, coverageType, threshold, ignoreFailures) {
  let infoToReturn = {
    badge: 'N/A',
    threshold: threshold,
    actualCoverage: 0,
    conclusion: 'success'
  };

  let regex;
  switch (coverageType) {
    case 'line':
      regex = /Line coverage: \| ([\d.]*)\%/;
      break;
    case 'branch':
      regex = /Branch coverage: \| ([\d.]*)\%/;
      break;
  }

  const itemFound = summaryInputData.match(regex);
  infoToReturn.actualCoverage = itemFound && itemFound[1] ? parseInt(itemFound[1]) : 0;
  if (infoToReturn.threshold === 0) {
    infoToReturn.conclusion = 'neutral';
  } else {
    if (infoToReturn.actualCoverage < infoToReturn.threshold) {
      infoToReturn.conclusion = ignoreFailures ? 'neutral' : 'failure';
    }

    infoToReturn.badge = getBadge(infoToReturn.conclusion);
  }

  return infoToReturn;
}

function getCoverageInfo(summaryInputData, lineThreshold, branchThreshold, ignoreFailures) {
  const info = {
    statusCheckConclusion: 'success',
    coverageOutcome: 'Passed',
    line: getIndividualCoverageInfo(summaryInputData, 'line', lineThreshold, ignoreFailures),
    branch: getIndividualCoverageInfo(summaryInputData, 'branch', branchThreshold, ignoreFailures)
  };

  if (info.branch.conclusion == 'failure' || info.line.conclusion == 'failure') {
    info.statusCheckConclusion = 'failure';
    info.coverageOutcome = 'Failed';
  } else if (info.branch.conclusion == 'neutral' || info.line.conclusion == 'neutral') {
    info.statusCheckConclusion = 'neutral';
    info.coverageOutcome = 'Passed';
  }

  return info;
}

async function run() {
  try {
    let summaryInput;
    if (fs.existsSync(summaryFile)) {
      summaryInput = fs.readFileSync(summaryFile, 'utf8');
      if (!summaryInput) {
        _info('The summary file does not contain any data.  No status check or pr comment will be created.');
        setOutput('coverage-outcome', 'Failed');
        return;
      }
    } else {
      setFailed(`The summary file '${summaryFile}' does not exist.  No status check or PR comment will be created.`);
      setOutput('coverage-outcome', 'Failed');
      return;
    }

    // |Scenario:                            | check conclusion | badge  | coverage-outcome |
    // |-------------------------------------|------------------|--------|------------------|
    // |threshold=0                          | neutral          | N/A    | Passed           |
    // |actual < threshold & !ignoreFailures | failure          | FAILED | Failed           |
    // |actual < threshold & ignoreFailures  | neutral          | FAILED | Passed           |
    // |actual >= threshold                  | success          | PASSED | Passed           |
    const coverageInfo = getCoverageInfo(summaryInput, lineThreshold, branchThreshold, ignoreFailures);
    setOutput('coverage-outcome', coverageInfo.coverageOutcome);

    const markdownResults = getMarkdownFromSummary(summaryInput, reportName, coverageInfo);

    if (shouldCreateStatusCheck) {
      const checkId = await createStatusCheck(reportName, checkName, markdownResults, coverageInfo.statusCheckConclusion);
      setOutput('status-check-id', checkId); // This is mainly for testing purposes
    }

    if (shouldCreatePRComment) {
      _info(`\nCreating a PR comment with length ${markdownResults.length}...`);

      // GitHub API has a limit of 65535 characters for a comment so truncate the markup if we need to
      const characterLimit = 65535;
      let truncated = false;
      let mdForPrComment = markdownResults;

      if (mdForPrComment.length > characterLimit) {
        const message = `Truncating markdown data due to character limit exceeded for GitHub API.  Markdown data length: ${mdForPrComment.length}/${characterLimit}`;
        _info(message);

        truncated = true;
        const truncatedMessage = `> [!Important]\n> Coverage results truncated due to character limit.  See full report in output.\n`;
        mdForPrComment = `${truncatedMessage}\n${mdForPrComment.substring(0, characterLimit - 100)}`;
      }
      setOutput('coverage-results-truncated', truncated);

      const commentId = await createPrComment(mdForPrComment, updateCommentIfOneExists, commentIdentifier);
      setOutput('pr-comment-id', commentId); // This is mainly for testing purposes
    }

    // Create this automatically to facilitate testing
    const resultsFilePath = createResultsFile(markdownResults, jobAndStep);
    setOutput('coverage-results-file-path', resultsFilePath);
  } catch (error) {
    setFailed(`An error occurred processing the summary file: ${error.message}`);
    setOutput('coverage-outcome', 'Failed');
  }
}

run();
