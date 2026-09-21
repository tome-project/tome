-- Migration 019: library invites (Plex-style one-link share) + decline_note on requests.
--
-- library_invites: host generates a link; redeemer gets friendship + collection
-- grants in one shot via redeem_library_invite().
--
-- decline_note: separate from requester `note` so decline reasons survive clearly.

-- ---------------------------------------------------------------------------
-- book_requests: explicit decline reason for members
-- ---------------------------------------------------------------------------
ALTER TABLE public.book_requests
  ADD COLUMN IF NOT EXISTS decline_note text;

-- ---------------------------------------------------------------------------
-- library_invites
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.library_invites (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token           text NOT NULL UNIQUE,
  owner_id        uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  server_id       uuid NOT NULL REFERENCES public.library_servers(id) ON DELETE CASCADE,
  collection_ids  uuid[] NOT NULL,
  label           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  revoked_at      timestamptz,
  redeem_count    int NOT NULL DEFAULT 0 CHECK (redeem_count >= 0)
);

CREATE INDEX IF NOT EXISTS idx_library_invites_owner
  ON public.library_invites (owner_id)
  WHERE revoked_at IS NULL;

ALTER TABLE public.library_invites ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "library_invites — owner manages" ON public.library_invites;
CREATE POLICY "library_invites — owner manages"
  ON public.library_invites FOR ALL TO authenticated
  USING (owner_id = auth.uid())
  WITH CHECK (owner_id = auth.uid());

-- ---------------------------------------------------------------------------
-- preview_library_invite — public-ish metadata for the redeem screen
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.preview_library_invite(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inv public.library_invites%ROWTYPE;
  v_owner public.user_profiles%ROWTYPE;
  v_server public.library_servers%ROWTYPE;
  v_collections jsonb;
BEGIN
  SELECT * INTO v_inv
    FROM public.library_invites
   WHERE token = upper(trim(p_token))
     AND revoked_at IS NULL;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_owner FROM public.user_profiles WHERE user_id = v_inv.owner_id;
  SELECT * INTO v_server FROM public.library_servers WHERE id = v_inv.server_id;

  SELECT coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name)), '[]'::jsonb)
    INTO v_collections
    FROM public.library_collections c
   WHERE c.id = ANY (v_inv.collection_ids);

  RETURN jsonb_build_object(
    'token', v_inv.token,
    'label', v_inv.label,
    'owner', jsonb_build_object(
      'user_id', v_owner.user_id,
      'handle', v_owner.handle,
      'display_name', v_owner.display_name,
      'avatar_url', v_owner.avatar_url
    ),
    'server', jsonb_build_object(
      'id', v_server.id,
      'name', v_server.name
    ),
    'collections', v_collections
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.preview_library_invite(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.preview_library_invite(text) TO anon;

-- ---------------------------------------------------------------------------
-- redeem_library_invite — friendship + grants atomically
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.redeem_library_invite(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me uuid := auth.uid();
  v_inv public.library_invites%ROWTYPE;
  v_owner_id uuid;
  v_cid uuid;
  v_user_a uuid;
  v_user_b uuid;
  v_inserted int := 0;
BEGIN
  IF v_me IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT * INTO v_inv
    FROM public.library_invites
   WHERE token = upper(trim(p_token))
     AND revoked_at IS NULL
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invalid or expired library invite';
  END IF;

  v_owner_id := v_inv.owner_id;

  IF v_owner_id = v_me THEN
    RAISE EXCEPTION 'Cannot redeem your own library invite';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.library_servers s
     WHERE s.id = v_inv.server_id AND s.owner_id = v_owner_id
  ) THEN
    RAISE EXCEPTION 'Library invite is no longer valid';
  END IF;

  -- Friendship (canonical ordered pair)
  IF v_me < v_owner_id THEN
    v_user_a := v_me;
    v_user_b := v_owner_id;
  ELSE
    v_user_a := v_owner_id;
    v_user_b := v_me;
  END IF;

  INSERT INTO public.friendships (user_a_id, user_b_id, status, requested_by, accepted_at)
  VALUES (v_user_a, v_user_b, 'accepted', v_me, now())
  ON CONFLICT (user_a_id, user_b_id) DO UPDATE
    SET status = 'accepted',
        accepted_at = coalesce(public.friendships.accepted_at, now());

  -- Collection grants (skip duplicates)
  FOREACH v_cid IN ARRAY v_inv.collection_ids LOOP
    IF EXISTS (
      SELECT 1 FROM public.library_collections c
       WHERE c.id = v_cid AND c.server_id = v_inv.server_id
    ) AND NOT EXISTS (
      SELECT 1 FROM public.library_server_grants g
       WHERE g.collection_id = v_cid
         AND g.grantee_id = v_me
         AND g.revoked_at IS NULL
    ) THEN
      INSERT INTO public.library_server_grants (collection_id, grantee_id, granted_by, server_id)
      VALUES (v_cid, v_me, v_owner_id, v_inv.server_id);
      v_inserted := v_inserted + 1;
    END IF;
  END LOOP;

  UPDATE public.library_invites
     SET redeem_count = redeem_count + 1
   WHERE id = v_inv.id;

  RETURN jsonb_build_object(
    'server_id', v_inv.server_id,
    'grants_added', v_inserted,
    'owner_id', v_owner_id
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.redeem_library_invite(text) TO authenticated;
