import { describe, expect, it } from 'vitest';
import { extractPublicTaskFields } from '../src/public-task-fields';
import { taskPreset } from '../src/task-presets';

describe('local transfer request instructions', () => {
  it('extracts all six starter values and leaves approval instructions out of the date', () => {
    expect(Object.fromEntries(extractPublicTaskFields(taskPreset('fill-public-fields')!.task))).toEqual({
      preferredName: 'Aarav Sharma', workEmail: 'aarav.sharma@example.test', phoneNumber: '+91 98765 43210',
      requestedCentre: 'Orbital Satellite Centre, Bengaluru', transferType: 'Family relocation', effectiveDate: '2026-11-15',
    });
  });
  it('retains the older enrollment aliases for existing tasks', () => {
    expect(Object.fromEntries(extractPublicTaskFields('preferred name Rohan Mehta, work email rohan@example.test, phone +91 91234 56789, city Pune, benefit plan Family Care Standard, coverage start date 2026-11-15. Then submit.'))).toEqual({
      preferredName: 'Rohan Mehta', workEmail: 'rohan@example.test', phoneNumber: '+91 91234 56789', city: 'Pune', benefitPlan: 'Family Care Standard', startDate: '2026-11-15',
    });
  });
  it('does not invent values or support entering government identifiers', () => {
    expect(extractPublicTaskFields('Review and submit the transfer request.').size).toBe(0);
    expect(extractPublicTaskFields('Aadhaar: 2345 6789 1234; PAN: ABCDE1234F').size).toBe(0);
  });
});
