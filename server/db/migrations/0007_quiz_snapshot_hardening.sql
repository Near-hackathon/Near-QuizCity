-- QC-0203 hardening: never snapshot a question that cannot be scored.

alter table quiz_attempt_questions
  add constraint quiz_attempt_questions_options_array_check check (
    jsonb_typeof(options) = 'array'
  ),
  add constraint quiz_attempt_questions_options_length_check check (
    jsonb_array_length(options) >= 2
  ),
  add constraint quiz_attempt_questions_correct_index_bounds_check check (
    correct_index < jsonb_array_length(options)
  );
