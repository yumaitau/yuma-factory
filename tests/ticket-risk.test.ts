import { test } from 'node:test';
import assert from 'node:assert/strict';
import { factoryRisk, isLowRisk, parseRiskLabel, riskLabel, ticketRisk } from '../shared/ticket-risk';

test('risk labels prefer the highest GitHub rating and ignore lookalikes', () => {
  assert.equal(ticketRisk([]), null);
  assert.equal(ticketRisk(['factory:ready']), null);
  assert.equal(ticketRisk(['factory:risk:low']), 'low');
  assert.equal(ticketRisk(['risk:low']), 'low');
  assert.equal(ticketRisk(['severity:low']), 'low');
  assert.equal(ticketRisk(['Risk / Low']), 'low');
  assert.equal(ticketRisk(['severity:critical']), 'high');
  assert.equal(ticketRisk(['factory:risk:low', 'severity:high']), 'high');
  assert.equal(ticketRisk(['not-factory:risk:low', 'ready']), null);
  assert.equal(ticketRisk(['priority:low']), null);
  assert.equal(isLowRisk(['severity:low']), true);
  assert.equal(isLowRisk(['factory:risk:low', 'severity:high']), false);
  assert.equal(parseRiskLabel('factory:risk:medium'), 'medium');
  assert.equal(riskLabel('low'), 'factory:risk:low');
  assert.equal(factoryRisk(['bug', 'factory:Risk:High']), 'high');
  assert.equal(factoryRisk(['risk:low']), null);
});

test('custom label prefix replaces the default prefix', () => {
  assert.equal(ticketRisk(['acme:risk:low'], 'acme'), 'low');
  assert.equal(ticketRisk(['factory:risk:low'], 'acme'), null);
  assert.equal(riskLabel('high', 'acme'), 'acme:risk:high');
  assert.equal(factoryRisk(['acme:risk:medium'], 'acme'), 'medium');
});
