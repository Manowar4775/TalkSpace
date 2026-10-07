import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, apikey, x-client-info, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Cache-Control": "no-store"
};

function jsonResponse(status: number, body: Record<string, unknown>) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
}

Deno.serve(async request => {
    if (request.method === "OPTIONS") {
        return new Response("ok", { headers: corsHeaders });
    }

    if (request.method !== "POST") {
        return jsonResponse(405, { error: "Method not allowed." });
    }

    const authorization = request.headers.get("Authorization") || "";
    const bearerMatch = authorization.match(/^Bearer\s+(.+)$/i);
    if (!bearerMatch) {
        return jsonResponse(401, { error: "Authentication is required." });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !anonKey || !serviceRoleKey) {
        return jsonResponse(500, { error: "Account deletion is not configured." });
    }

    try {
        const authClient = createClient(supabaseUrl, anonKey, {
            auth: { autoRefreshToken: false, persistSession: false }
        });
        const { data: authData, error: authError } = await authClient.auth.getUser(bearerMatch[1]);
        if (authError || !authData.user?.id) {
            return jsonResponse(401, { error: "The authenticated session could not be verified." });
        }

        const adminClient = createClient(supabaseUrl, serviceRoleKey, {
            auth: { autoRefreshToken: false, persistSession: false }
        });
        // The deletion target comes only from the user returned by Auth for this bearer token.
        // The request body is intentionally never read and cannot select another account.
        const { error: deletionError } = await adminClient.auth.admin.deleteUser(authData.user.id, false);
        if (deletionError) {
            return jsonResponse(500, { error: "The account could not be deleted." });
        }

        return jsonResponse(200, { success: true });
    } catch (_error) {
        return jsonResponse(500, { error: "The account could not be deleted." });
    }
});
