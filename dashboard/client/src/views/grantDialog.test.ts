import { describe, expect, it } from 'vitest';
import { EXPIRY_CHOICES, grantChoices } from './GrantDialog';

describe('grantChoices', () => {
  it('offers each action once, naming every gate it covers, in gate order', () => {
    expect(grantChoices([
      { gate: 'stg', action: 'deploy_staging' },
      { gate: 'prod', action: 'deploy_production' },
      { gate: 'stg-2', action: 'deploy_staging' },
    ])).toEqual([
      { action: 'deploy_staging', gates: ['stg', 'stg-2'] },
      { action: 'deploy_production', gates: ['prod'] },
    ]);
    expect(grantChoices([])).toEqual([]);
  });
});

describe('EXPIRY_CHOICES', () => {
  it('defaults to no expiry and stays inside the server limit of 1 to 168 hours', () => {
    expect(EXPIRY_CHOICES[0].hours).toBeNull();
    for (const { hours } of EXPIRY_CHOICES.slice(1)) {
      expect(Number.isInteger(hours) && hours! >= 1 && hours! <= 168).toBe(true);
    }
  });
});
