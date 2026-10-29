# Client customer contacts — integration notes

Production Orbit application source lives in the private `mustardseedgroup/orbit` repository. This showcase repo carries the migration, rollback SQL, admin UI module, edge function, and tests for the client customer contacts store.

## Wire-up in the private app

1. Apply `supabase/migrations/20261029194500_client_customer_contacts.sql` via Salt (do **not** apply from this PR automatically).
2. Mount `ClientDetailCustomerContactsSection` from `src/pages/admin/ClientDetailPage.customerContacts.tsx` on `/clients/:id` for admins only.
3. Deploy edge function `client-customer-contacts-import`.
4. Confirm Orbit MCP tools do not expose write/send/enroll actions for `client_customer_contacts`.

## Rollback

Run `supabase/migrations/rollback/20261029194500_client_customer_contacts.rollback.sql` if the feature must be removed.

## Acceptance tests against a preview branch

```bash
export ORBIT_ACCEPTANCE_SUPABASE_URL="https://<branch-ref>.supabase.co"
export ORBIT_ACCEPTANCE_SERVICE_ROLE_KEY="<service-role>"
npm run test:acceptance
```

Use hello+…@chikoshire.com test users to verify non-admin and portal users receive zero rows via the API after migration.
