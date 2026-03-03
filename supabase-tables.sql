-- Tienes que copiar y pegar todo este código en el "SQL Editor" de tu Supabase y darle al botón "Run".

-- 1. Crear tabla de Usuarios Autorizados
CREATE TABLE IF NOT EXISTS public.bot_users (
    chat_id text PRIMARY KEY,
    name text,
    plan text DEFAULT 'credits'::text,
    credits int4 DEFAULT 0,
    created_at timestamp with time zone DEFAULT now()
);

-- 2. Crear tabla de asociacion Link -> Chat_ID (dueño del link)
CREATE TABLE IF NOT EXISTS public.bot_links (
    target_id text PRIMARY KEY,
    chat_id text REFERENCES public.bot_users(chat_id) ON DELETE CASCADE,
    created_at timestamp with time zone DEFAULT now()
);

-- 3. Habilitar o Deshabilitar RLS (Policies de seguridad). 
-- Para backend de NodeJS está bien tenerlo desactivado temporalmente para pruebas.
ALTER TABLE public.bot_users DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.bot_links DISABLE ROW LEVEL SECURITY;
