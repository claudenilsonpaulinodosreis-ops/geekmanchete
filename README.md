-- Refine role-check helper: only permit checking the caller's own role.
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles ur
    WHERE ur.user_id = _user_id
      AND ur.role = _role
      AND _user_id = auth.uid()
  );
$function$;

REVOKE ALL ON FUNCTION public.has_role(uuid, public.app_role) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) TO authenticated, service_role;

-- Explicitly document the worker-only RLS path for private ingestion tables.
DROP POLICY IF EXISTS "Worker manages processed links" ON public.processed_links;
CREATE POLICY "Worker manages processed links"
ON public.processed_links FOR ALL TO service_role
USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Worker manages job state" ON public.job_state;
CREATE POLICY "Worker manages job state"
ON public.job_state FOR ALL TO service_role
USING (true) WITH CHECK (true);

-- Avoid per-row re-evaluation of the admin helper in GeekManchete policies.
DROP POLICY IF EXISTS "Admins add articles" ON public.articles;
CREATE POLICY "Admins add articles"
ON public.articles FOR INSERT TO authenticated
WITH CHECK ((SELECT public.has_role((SELECT auth.uid()), 'admin'::public.app_role)));

DROP POLICY IF EXISTS "Admins edit articles" ON public.articles;
CREATE POLICY "Admins edit articles"
ON public.articles FOR UPDATE TO authenticated
USING ((SELECT public.has_role((SELECT auth.uid()), 'admin'::public.app_role)))
WITH CHECK ((SELECT public.has_role((SELECT auth.uid()), 'admin'::public.app_role)));

DROP POLICY IF EXISTS "Admins delete articles" ON public.articles;
CREATE POLICY "Admins delete articles"
ON public.articles FOR DELETE TO authenticated
USING ((SELECT public.has_role((SELECT auth.uid()), 'admin'::public.app_role)));

DROP POLICY IF EXISTS "Admins add products" ON public.products;
CREATE POLICY "Admins add products"
ON public.products FOR INSERT TO authenticated
WITH CHECK ((SELECT public.has_role((SELECT auth.uid()), 'admin'::public.app_role)));

DROP POLICY IF EXISTS "Admins edit products" ON public.products;
CREATE POLICY "Admins edit products"
ON public.products FOR UPDATE TO authenticated
USING ((SELECT public.has_role((SELECT auth.uid()), 'admin'::public.app_role)))
WITH CHECK ((SELECT public.has_role((SELECT auth.uid()), 'admin'::public.app_role)));

DROP POLICY IF EXISTS "Admins delete products" ON public.products;
CREATE POLICY "Admins delete products"
ON public.products FOR DELETE TO authenticated
USING ((SELECT public.has_role((SELECT auth.uid()), 'admin'::public.app_role)));

DROP POLICY IF EXISTS "Admins see all products" ON public.products;
CREATE POLICY "Admins see all products"
ON public.products FOR SELECT TO authenticated
USING ((SELECT public.has_role((SELECT auth.uid()), 'admin'::public.app_role)));
;
