-- 011_invite_codes.sql
-- Personal invite codes on user_profiles. Redeeming a code creates an
-- accepted friendship in both directions AND auto-shares all of the
-- inviter's media_servers to the accepter, so the whole "share my library
-- with my wife" flow becomes a single link tap on her side.
--
-- Design notes:
--   - One invite_code per user, rotatable. 8 lowercase alphanumeric chars.
--     ~2.8e12 address space; collisions are effectively impossible at the
--     scale Tome will ever hit, and we add a unique constraint anyway.
--   - We don't expire codes. A user who leaks theirs can rotate via
--     POST /api/v1/invites/rotate (regenerates the column).
--   - The accept action is wrapped in a SECURITY DEFINER function so we
--     can do the friendship upsert + server_shares inserts atomically,
--     skipping RLS on the inviter's rows. Callers still need to be
--     authenticated — auth.uid() is the accepter.

-- 1. Column + unique index. Starts NULL so we can backfill without
--    tripping NOT NULL; we set NOT NULL at the end.
ALTER TABLE public.user_profiles
  ADD COLUMN invite_code text;

-- Generator. 8-char alphanumeric; avoids ambiguous 0/o/1/l chars so the
-- code can be read aloud without confusion.
CREATE OR REPLACE FUNCTION public.generate_invite_code()
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  alphabet text := 'abcdefghjkmnpqrstuvwxyz23456789';
  code text;
  i int;
BEGIN
  LOOP
    code := '';
    FOR i IN 1..8 LOOP
      code := code || substr(alphabet, (floor(random() * length(alphabet)) + 1)::int, 1);
    END LOOP;
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.user_profiles WHERE invite_code = code);
  END LOOP;
  RETURN code;
END;
$$;

-- Backfill existing rows.
UPDATE public.user_profiles
   SET invite_code = public.generate_invite_code()
 WHERE invite_code IS NULL;

ALTER TABLE public.user_profiles
  ALTER COLUMN invite_code SET NOT NULL,
  ADD CONSTRAINT user_profiles_invite_code_unique UNIQUE (invite_code);

CREATE INDEX idx_user_profiles_invite_code ON public.user_profiles (invite_code);

-- 2. Have the handle_new_user trigger populate invite_code on signup too.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  placeholder text;
  counter int := 0;
BEGIN
  -- Placeholder handle: "user_{shortid}". Uniqueness loop in case of collision.
  LOOP
    placeholder := 'user_' || substr(md5(random()::text || counter::text), 1, 8);
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.user_profiles WHERE handle = placeholder);
    counter := counter + 1;
  END LOOP;

  INSERT INTO public.user_profiles (user_id, handle, display_name, handle_claimed, invite_code)
  VALUES (
    NEW.id,
    placeholder,
    COALESCE(NEW.raw_user_meta_data->>'display_name', split_part(NEW.email, '@', 1)),
    false,
    public.generate_invite_code()
  );
  RETURN NEW;
END;
$$;

-- 3. Accept-invite function. Looks up inviter by code, creates friendship
--    in accepted state, and auto-grants shares for every media_server the
--    inviter owns. Idempotent: re-running with an already-friend is a no-op
--    on friendship (ON CONFLICT) but still top-ups any missing server_shares
--    the inviter has added since the last redemption.
CREATE OR REPLACE FUNCTION public.accept_invite(p_code text)
RETURNS TABLE (
  inviter_user_id uuid,
  inviter_handle text,
  inviter_display_name text,
  servers_shared int
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_accepter uuid := auth.uid();
  v_inviter uuid;
  v_user_a uuid;
  v_user_b uuid;
  v_count int := 0;
BEGIN
  IF v_accepter IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '42501';
  END IF;

  SELECT user_id INTO v_inviter
    FROM public.user_profiles
   WHERE invite_code = lower(p_code);

  IF v_inviter IS NULL THEN
    RAISE EXCEPTION 'invalid invite code' USING ERRCODE = 'P0002';
  END IF;

  IF v_inviter = v_accepter THEN
    RAISE EXCEPTION 'cannot redeem your own invite code' USING ERRCODE = '22023';
  END IF;

  -- friendships stores (user_a_id < user_b_id) as a canonical ordering.
  IF v_accepter < v_inviter THEN
    v_user_a := v_accepter;
    v_user_b := v_inviter;
  ELSE
    v_user_a := v_inviter;
    v_user_b := v_accepter;
  END IF;

  INSERT INTO public.friendships (user_a_id, user_b_id, status, requested_by, accepted_at)
    VALUES (v_user_a, v_user_b, 'accepted', v_inviter, now())
    ON CONFLICT (user_a_id, user_b_id) DO UPDATE
      SET status = 'accepted',
          accepted_at = COALESCE(public.friendships.accepted_at, now())
      WHERE public.friendships.status <> 'accepted';

  -- Auto-share every media_server the inviter owns. Skip dupes via ON CONFLICT.
  INSERT INTO public.server_shares (media_server_id, grantee_id)
  SELECT ms.id, v_accepter
    FROM public.media_servers ms
   WHERE ms.owner_id = v_inviter
  ON CONFLICT (media_server_id, grantee_id) DO NOTHING;

  GET DIAGNOSTICS v_count = ROW_COUNT;

  RETURN QUERY
    SELECT up.user_id, up.handle, up.display_name, v_count
      FROM public.user_profiles up
     WHERE up.user_id = v_inviter;
END;
$$;

-- Let any authenticated user call the RPC; internal guards do the rest.
GRANT EXECUTE ON FUNCTION public.accept_invite(text) TO authenticated;

-- 4. Rotate function. Generates a new code and returns it.
CREATE OR REPLACE FUNCTION public.rotate_invite_code()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_new text;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '42501';
  END IF;
  v_new := public.generate_invite_code();
  UPDATE public.user_profiles
     SET invite_code = v_new,
         updated_at = now()
   WHERE user_id = v_user;
  RETURN v_new;
END;
$$;
GRANT EXECUTE ON FUNCTION public.rotate_invite_code() TO authenticated;
