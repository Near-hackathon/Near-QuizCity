create table job_research_tasks (
 job_id text primary key references jobs(id),
 snapshot jsonb not null check(jsonb_typeof(snapshot)='object'),
 created_at timestamptz not null default now()
);
create table job_research_submissions (
 id bigserial primary key,
 job_id text not null references job_research_tasks(job_id),
 fingerprint text not null check(length(fingerprint)=64),
 summary text not null check(length(summary) between 20 and 2000),
 answers jsonb not null check(jsonb_typeof(answers)='object'),
 score int not null check(score>=0),
 total int not null check(total>0 and score<=total),
 created_at timestamptz not null default now(),
 unique(job_id,fingerprint)
);
alter table jobs add column has_research_task boolean not null default false;

-- Only unaccepted NPC offers adopt the concrete research brief. Accepted/submitted work is preserved.
insert into job_research_tasks(job_id,snapshot) select id,'{"version":"near-city-v1","title":"Research the foundations of your city","reading":"NEAR Protocol is blockchain infrastructure for applications. NEAR Intents supports execution across different blockchains. Wallet keys prove control of assets: keep private keys private, and only approve transactions you understand.","source":"https://near.org/","questions":[{"id":"infrastructure","question":"What kind of infrastructure is NEAR Protocol?","options":["A blockchain","A search engine","A spreadsheet"],"correct":0},{"id":"intents","question":"What does NEAR Intents support?","options":["Decorating a home","Cross-chain execution","Offline file storage"],"correct":1},{"id":"ownership","question":"Which action protects your city wallet?","options":["Posting your private key","Approving every request","Keeping your private key private"],"correct":2}]}'::jsonb from jobs where employer_wallet='npc:professor-kofi' and status='open' on conflict(job_id) do nothing;
update jobs set has_research_task=true,title='Research the foundations of NEAR',description='Read the source brief, complete its knowledge check and submit a short research summary from your phone.' where employer_wallet='npc:professor-kofi' and status='open' and id in(select job_id from job_research_tasks);
