/** Small starter tasks for the popup and persistent side panel.
 *
 * Presets only fill the local task text box. They never inspect the page,
 * persist values, or change the reasoning protocol. Demo data must remain
 * synthetic and editable because it is processed under the selected grade
 * only after the user explicitly starts a run.
 */
export type TaskPresetId = 'review-submit' | 'fill-public-fields' | 'find-information' | 'scroll-summary';

export type TaskPreset = Readonly<{
  id: TaskPresetId;
  label: string;
  task: string;
}>;

export const TASK_PRESETS: readonly TaskPreset[] = [
  {
    id: 'review-submit',
    label: 'Review and submit a form',
    task: 'Review the visible form, check any required consent checkbox, then submit it.',
  },
  {
    id: 'fill-public-fields',
    label: 'Fill public fields from my instructions',
    task: 'Fill the public demo form fields with: preferred name Rohan Mehta, work email rohan.mehta@example.test, phone +91 91234 56789, city Pune, benefit plan Family Care Standard, coverage start date 2026-11-15. Then check the consent box and submit the enrollment.',
  },
  {
    id: 'find-information',
    label: 'Find information on this page',
    task: 'Find the requested information on this page and finish when it is visible.',
  },
  {
    id: 'scroll-summary',
    label: 'Read through the page',
    task: 'Scroll through the page and stop when you have reached the relevant section.',
  },
];

export function taskPreset(id: string): TaskPreset | undefined {
  return TASK_PRESETS.find((preset) => preset.id === id);
}
