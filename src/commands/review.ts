import {
  ReviewInspectionError,
  inspectReviewSubject,
} from '../system/review-subject.js';

export interface ReviewInspectOptions {
  base: string;
  json?: boolean;
}

export async function reviewInspect(
  options: ReviewInspectOptions,
  projectRoot: string = process.cwd(),
): Promise<number> {
  try {
    const subject = await inspectReviewSubject(projectRoot, options.base);
    if (options.json) console.log(JSON.stringify(subject, null, 2));
    else {
      console.log(
        `Review inventory: ${subject.base.commit} -> HEAD ${subject.head} / index / working tree`,
      );
      for (const file of subject.files) {
        const from =
          file.previousPath === undefined
            ? ''
            : `${JSON.stringify(file.previousPath)} -> `;
        console.log(
          `${file.status} [${file.layers.join(', ')}]: ${from}${JSON.stringify(file.path)}`,
        );
      }
      console.log(
        `${subject.files.length} entries; semantic review and verification have not been performed.`,
      );
      for (const note of subject.notes) console.log(note);
    }
    return 0;
  } catch (error) {
    const failure =
      error instanceof ReviewInspectionError
        ? error
        : new ReviewInspectionError(
            'MANCODE_REVIEW_INSPECTION_FAILED',
            'Review inventory could not be captured.',
          );
    if (options.json)
      console.log(
        JSON.stringify(
          { error: { code: failure.code, message: failure.message } },
          null,
          2,
        ),
      );
    else console.error(`${failure.code}: ${failure.message}`);
    return 1;
  }
}
