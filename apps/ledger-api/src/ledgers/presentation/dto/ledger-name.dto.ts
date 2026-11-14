import { z } from 'zod';
import { LEDGER_NAME_PATTERN } from '../../domain/constants/ledger-name.constant.js';

/**
 * Shape of a ledger name at the HTTP edge: the `name` field of the create body
 * and the `:name` part of the ledger URL. It checks the shape only. Reserved
 * names are a domain rule, so `Ledger.create` checks them.
 */
export const ledgerNameSchema = z.string().regex(LEDGER_NAME_PATTERN, {
  error:
    'Must be 1 to 63 characters: lowercase letters, digits, "_" or "-", and start with a letter or digit',
});
