import { describe, expect, it } from 'vitest';
import { TASK_PRESETS, taskPreset } from '../src/task-presets';

describe('task presets', () => {
  it('keeps a small set of editable starter tasks without secrets', () => {
    expect(TASK_PRESETS.length).toBe(4);
    expect(TASK_PRESETS.every((preset) => preset.task.length > 20)).toBe(true);
    expect(TASK_PRESETS.some((preset) => /password|secret|token|api[_ -]?key|otp|cvv/i.test(preset.task))).toBe(false);
    expect(taskPreset('fill-public-fields')?.task).toContain('example.test');
  });

  it('looks up a preset without accepting arbitrary values', () => {
    expect(taskPreset('review-submit')?.label).toBe('Review and submit a form');
    expect(taskPreset('unknown')).toBeUndefined();
  });
});
