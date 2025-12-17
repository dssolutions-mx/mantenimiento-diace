import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase-server'
import { createAdminClient } from '@/lib/supabase-admin'

// DELETE /api/users/[id]
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const supabase = await createClient()

    // AuthN
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { id: targetUserId } = await params
    if (!targetUserId) {
      return NextResponse.json({ error: 'Missing user id' }, { status: 400 })
    }

    // Load current user profile
    const { data: currentProfile, error: profileError } = await supabase
      .from('profiles')
      .select('id, role')
      .eq('id', user.id)
      .single()

    if (profileError || !currentProfile) {
      return NextResponse.json({ error: 'Profile not found' }, { status: 404 })
    }

    // Only GERENCIA_GENERAL can permanently delete users
    if (currentProfile.role !== 'GERENCIA_GENERAL') {
      return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 })
    }

    // Prevent self-deletion
    if (targetUserId === currentProfile.id) {
      return NextResponse.json({ error: 'No puedes eliminar tu propio usuario' }, { status: 400 })
    }

    // Best-effort: delete Supabase auth user via Admin
    try {
      const admin = createAdminClient()
      // Prefer new SDK admin delete method
      if (typeof (admin as any).auth?.admin?.deleteUser === 'function') {
        await (admin as any).auth.admin.deleteUser(targetUserId)
      } else if (typeof (admin as any).auth?.admin?.deleteUserById === 'function') {
        await (admin as any).auth.admin.deleteUserById(targetUserId)
      } else if (typeof (admin as any).auth?.admin?.users?.delete === 'function') {
        await (admin as any).auth.admin.users.delete(targetUserId)
      } else {
        console.warn('Admin client does not support deleteUser on this SDK version')
      }
    } catch (adminError) {
      console.error('Failed to delete auth user via admin:', adminError)
      return NextResponse.json({ error: 'No se pudo eliminar el usuario de autenticación' }, { status: 500 })
    }

    // Remove profile row (if not cascaded)
    const { error: profileDeleteError } = await supabase
      .from('profiles')
      .delete()
      .eq('id', targetUserId)

    if (profileDeleteError) {
      console.warn('Profile delete error (may be already cascaded):', profileDeleteError.message)
    }

    return NextResponse.json({ message: 'Usuario eliminado permanentemente' })
  } catch (error) {
    console.error('Unexpected error in DELETE /api/users/[id]:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}


