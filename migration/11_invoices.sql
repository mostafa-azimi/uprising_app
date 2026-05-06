-- Invoice generator: stores per-event invoices with editable bill-to / remit-to,
-- line items (with optional discount %), and a paid/draft status.
--
-- Invoice numbers continue from where the legacy spreadsheet system left off
-- (last manually-issued invoice was #2804), so we start the sequence at 2805.

create sequence if not exists invoice_number_seq start with 2805;

create table if not exists invoices (
  id uuid primary key default gen_random_uuid(),
  event_id uuid references events(id) on delete set null,
  invoice_number text not null default ('#' || nextval('invoice_number_seq')::text),
  invoice_date date not null default current_date,
  due_date date,
  payment_terms text default 'Net 10',

  bill_to_name text default 'NADGT',
  bill_to_address text default '3061 N Columbia St Suite D' || chr(10) || 'Milledgeville, GA 31061',

  remit_to_name text default 'DiscHub',
  remit_to_address text default '3061 N Columbia St Suite D' || chr(10) || 'Milledgeville, GA 31061',

  -- Line items: jsonb array of { description, amount, discount_pct, line_total }
  -- Stored verbatim from the form so positive AND negative amounts are allowed
  -- (negatives let the user reduce the invoice for refunds, credits, etc.).
  line_items jsonb not null default '[]'::jsonb,

  subtotal numeric(12, 2) not null default 0,
  total numeric(12, 2) not null default 0,

  status text not null default 'draft' check (status in ('draft', 'sent', 'paid', 'void')),
  paid_at timestamptz,

  notes text,

  created_by uuid,
  created_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists invoices_invoice_number_unique on invoices(invoice_number);
create index if not exists invoices_event_id_idx on invoices(event_id);
create index if not exists invoices_status_idx on invoices(status);

-- Keep updated_at fresh on every row update.
create or replace function set_invoices_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists invoices_set_updated_at on invoices;
create trigger invoices_set_updated_at
  before update on invoices
  for each row execute function set_invoices_updated_at();

-- RLS: only service role writes; authenticated users can read.
alter table invoices enable row level security;

drop policy if exists invoices_read_authenticated on invoices;
create policy invoices_read_authenticated on invoices
  for select to authenticated using (true);

notify pgrst, 'reload schema';
