-- Two side stations replace the crowded quiz-centre tables. Apply with workers stopped.
-- Keep existing venue hours, residents, wallets, quizzes and match escrows intact.
create temporary table quiz_walkway_new_obstacles (x int,y int,width int,height int) on commit drop;
insert into quiz_walkway_new_obstacles values (3,7,2,1),(4,8,1,1),(15,7,2,1),(16,8,1,1);
update scenes set asset_version=5,updated_at=now() where id='quiz-centre-interior';
update player_presence p set
 x=case when exists(select 1 from quiz_walkway_new_obstacles b where p.x>=b.x and p.x<b.x+b.width and p.y>=b.y and p.y<b.y+b.height) then 10 else p.x end,
 y=case when exists(select 1 from quiz_walkway_new_obstacles b where p.x>=b.x and p.x<b.x+b.width and p.y>=b.y and p.y<b.y+b.height) then 11 else p.y end,
 path='[]'::jsonb,path_index=0,scene_version=5,state_version=p.state_version+1
where p.scene_id='quiz-centre-interior';
update npc_runtime n set
 x=case when exists(select 1 from quiz_walkway_new_obstacles b where n.x>=b.x and n.x<b.x+b.width and n.y>=b.y and n.y<b.y+b.height) then 10 else n.x end,
 y=case when exists(select 1 from quiz_walkway_new_obstacles b where n.x>=b.x and n.x<b.x+b.width and n.y>=b.y and n.y<b.y+b.height) then 11 else n.y end,
 target_scene_id=null,target_spawn_id=null,target_x=null,target_y=null,
 state='{}'::jsonb,last_simulated_at=null,state_version=n.state_version+1,updated_at=now()
where n.scene_id='quiz-centre-interior';
