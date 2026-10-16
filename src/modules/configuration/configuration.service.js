import { prisma } from '../../lib/prisma.js';
import { logConfigAction } from './configAudit.service.js';
import { prepareSoftDeletePayload, activeRecordsFilter } from '../../lib/softDelete.js';
import { validateResumeFile } from './candidateVisibilityPolicy.js';

export class ConfigurationService {
  // ==========================================
  // A. Industry & Sector Management
  // ==========================================

  static async getIndustries({
    search,
    status = 'ALL',
    parentId,
    hierarchy,
    page = 1,
    limit = 20,
    sortBy = 'name',
    sortOrder = 'asc',
  } = {}) {
    const where = {
      ...activeRecordsFilter(),
    };

    if (status && status !== 'ALL') {
      where.status = status;
    }

    if (parentId !== undefined) {
      where.parentId = parentId === 'null' || parentId === '' ? null : parentId;
    }

    if (search && search.trim()) {
      where.OR = [
        { name: { contains: search.trim(), mode: 'insensitive' } },
        { code: { contains: search.trim(), mode: 'insensitive' } },
        { description: { contains: search.trim(), mode: 'insensitive' } },
      ];
    }

    // If hierarchy mode requested, fetch root industries with children
    if (hierarchy === 'true' || hierarchy === true) {
      const rootIndustries = await prisma.industry.findMany({
        where: {
          ...where,
          parentId: null,
        },
        orderBy: { [sortBy]: sortOrder },
        include: {
          children: {
            where: activeRecordsFilter(),
            orderBy: { name: 'asc' },
            include: {
              children: {
                where: activeRecordsFilter(),
                orderBy: { name: 'asc' },
              },
            },
          },
        },
      });

      return {
        data: rootIndustries,
        total: rootIndustries.length,
      };
    }

    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      prisma.industry.findMany({
        where,
        skip,
        take: limit,
        orderBy: { [sortBy]: sortOrder },
        include: {
          parent: {
            select: { id: true, name: true, code: true, status: true },
          },
          _count: {
            select: { children: { where: activeRecordsFilter() } },
          },
        },
      }),
      prisma.industry.count({ where }),
    ]);

    return {
      data,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  static async getIndustryById(id) {
    const industry = await prisma.industry.findFirst({
      where: { id, ...activeRecordsFilter() },
      include: {
        parent: {
          select: { id: true, name: true, code: true, status: true },
        },
        children: {
          where: activeRecordsFilter(),
          select: { id: true, name: true, code: true, status: true, createdAt: true },
        },
      },
    });

    if (!industry) {
      const err = new Error(`Industry with ID "${id}" was not found.`);
      err.status = 404;
      throw err;
    }

    return industry;
  }

  static async createIndustry(payload, adminContext = {}) {
    const { name, code, description, parentId, status = 'ACTIVE' } = payload;

    // 1. Verify parent if specified
    if (parentId) {
      const parent = await prisma.industry.findFirst({
        where: { id: parentId, ...activeRecordsFilter() },
      });
      if (!parent) {
        const err = new Error(`Specified parent industry with ID "${parentId}" does not exist.`);
        err.status = 400;
        throw err;
      }
    }

    // 2. Prevent duplicate names within the same parent scope (case-insensitive)
    const existing = await prisma.industry.findFirst({
      where: {
        parentId: parentId || null,
        name: { equals: name.trim(), mode: 'insensitive' },
        ...activeRecordsFilter(),
      },
    });

    if (existing) {
      const scopeLabel = parentId ? 'under this parent industry' : 'at the root industry level';
      const err = new Error(`An industry with the name "${name.trim()}" already exists ${scopeLabel}.`);
      err.status = 409;
      throw err;
    }

    const industry = await prisma.industry.create({
      data: {
        name: name.trim(),
        code: code?.trim() || null,
        description: description?.trim() || null,
        parentId: parentId || null,
        status,
      },
      include: {
        parent: { select: { id: true, name: true } },
      },
    });

    await logConfigAction({
      adminId: adminContext.id,
      entityType: 'INDUSTRY',
      entityId: industry.id,
      action: 'CREATE',
      actor: adminContext.name || adminContext.email || 'ADMIN',
      details: { name: industry.name, parentId: industry.parentId, status: industry.status },
    });

    return industry;
  }

  static async updateIndustry(id, payload, adminContext = {}) {
    const existing = await prisma.industry.findFirst({
      where: { id, ...activeRecordsFilter() },
      include: { children: { where: activeRecordsFilter() } },
    });

    if (!existing) {
      const err = new Error(`Industry with ID "${id}" was not found.`);
      err.status = 404;
      throw err;
    }

    const effectiveParentId = payload.parentId !== undefined ? payload.parentId : existing.parentId;

    // 1. Prevent circular hierarchy (setting parent to self or any descendant)
    if (payload.parentId) {
      if (payload.parentId === id) {
        const err = new Error('An industry cannot be its own parent.');
        err.status = 400;
        throw err;
      }

      // Check if candidate parent is a descendant
      let currentCheck = payload.parentId;
      const visited = new Set([id]);
      while (currentCheck) {
        if (visited.has(currentCheck)) {
          const err = new Error('Circular hierarchy detected: cannot set parent to a descendant industry.');
          err.status = 400;
          throw err;
        }
        visited.add(currentCheck);
        const ancestor = await prisma.industry.findUnique({
          where: { id: currentCheck },
          select: { parentId: true },
        });
        currentCheck = ancestor?.parentId || null;
      }
    }

    // 2. Prevent duplicate names in target parent scope
    const targetName = payload.name !== undefined ? payload.name.trim() : existing.name;
    const duplicate = await prisma.industry.findFirst({
      where: {
        id: { not: id },
        parentId: effectiveParentId || null,
        name: { equals: targetName, mode: 'insensitive' },
        ...activeRecordsFilter(),
      },
    });

    if (duplicate) {
      const scopeLabel = effectiveParentId ? 'under this parent industry' : 'at the root industry level';
      const err = new Error(`An industry with the name "${targetName}" already exists ${scopeLabel}.`);
      err.status = 409;
      throw err;
    }

    const updated = await prisma.industry.update({
      where: { id },
      data: {
        name: payload.name !== undefined ? payload.name.trim() : undefined,
        code: payload.code !== undefined ? payload.code?.trim() || null : undefined,
        description: payload.description !== undefined ? payload.description?.trim() || null : undefined,
        parentId: payload.parentId !== undefined ? payload.parentId || null : undefined,
        status: payload.status !== undefined ? payload.status : undefined,
      },
      include: {
        parent: { select: { id: true, name: true } },
      },
    });

    await logConfigAction({
      adminId: adminContext.id,
      entityType: 'INDUSTRY',
      entityId: id,
      action: 'UPDATE',
      actor: adminContext.name || adminContext.email || 'ADMIN',
      details: {
        previous: { name: existing.name, parentId: existing.parentId, status: existing.status },
        updated: { name: updated.name, parentId: updated.parentId, status: updated.status },
      },
    });

    return updated;
  }

  static async toggleIndustryStatus(id, newStatus, adminContext = {}) {
    const existing = await prisma.industry.findFirst({
      where: { id, ...activeRecordsFilter() },
      include: {
        children: {
          where: {
            status: 'ACTIVE',
            ...activeRecordsFilter(),
          },
        },
      },
    });

    if (!existing) {
      const err = new Error(`Industry with ID "${id}" was not found.`);
      err.status = 404;
      throw err;
    }

    // Safety rule: Prevent deactivating a parent industry if it has active child industries
    if (newStatus === 'INACTIVE' && existing.children.length > 0) {
      const err = new Error(
        `Cannot deactivate "${existing.name}" because it has ${existing.children.length} active sub-industries/departments. Please deactivate or reassign child records first.`
      );
      err.status = 400;
      throw err;
    }

    const updated = await prisma.industry.update({
      where: { id },
      data: { status: newStatus },
    });

    await logConfigAction({
      adminId: adminContext.id,
      entityType: 'INDUSTRY',
      entityId: id,
      action: newStatus === 'ACTIVE' ? 'ACTIVATE' : 'DEACTIVATE',
      actor: adminContext.name || adminContext.email || 'ADMIN',
      details: { previousStatus: existing.status, newStatus },
    });

    return updated;
  }

  static async deleteIndustry(id, mode = 'MOVE_TO_TRASH', adminContext = {}) {
    const existing = await prisma.industry.findUnique({
      where: { id },
      include: {
        children: { where: activeRecordsFilter() },
      },
    });

    if (!existing || existing.deletedAt !== null) {
      const err = new Error(`Industry with ID "${id}" was not found.`);
      err.status = 404;
      throw err;
    }

    // Safety rule: Cannot delete industry with existing children
    if (existing.children.length > 0) {
      const err = new Error(
        `Cannot delete "${existing.name}" because it contains ${existing.children.length} sub-industries/departments. Remove or reassign child records before deleting.`
      );
      err.status = 400;
      throw err;
    }

    if (mode === 'DELETE_PERMANENTLY') {
      await prisma.industry.delete({ where: { id } });

      await logConfigAction({
        adminId: adminContext.id,
        entityType: 'INDUSTRY',
        entityId: id,
        action: 'DELETE_PERMANENTLY',
        actor: adminContext.name || adminContext.email || 'ADMIN',
        details: { name: existing.name, parentId: existing.parentId },
      });

      return { success: true, message: `Industry "${existing.name}" was permanently deleted.` };
    }

    // Default: Soft delete (MOVE_TO_TRASH)
    const softPayload = prepareSoftDeletePayload(adminContext.id);
    await prisma.industry.update({
      where: { id },
      data: {
        ...softPayload,
        status: 'INACTIVE',
      },
    });

    await logConfigAction({
      adminId: adminContext.id,
      entityType: 'INDUSTRY',
      entityId: id,
      action: 'MOVE_TO_TRASH',
      actor: adminContext.name || adminContext.email || 'ADMIN',
      details: { name: existing.name },
    });

    return { success: true, message: `Industry "${existing.name}" moved to Trash.` };
  }

  // ==========================================
  // B & C. Document Definitions (Company & Candidate)
  // ==========================================

  static async getDocumentDefinitions({
    targetType,
    status = 'ALL',
    search,
    page = 1,
    limit = 20,
  } = {}) {
    const where = {
      ...activeRecordsFilter(),
    };

    if (targetType) {
      where.targetType = targetType;
    }

    if (status && status !== 'ALL') {
      where.status = status;
    }

    if (search && search.trim()) {
      where.OR = [
        { name: { contains: search.trim(), mode: 'insensitive' } },
        { code: { contains: search.trim(), mode: 'insensitive' } },
        { description: { contains: search.trim(), mode: 'insensitive' } },
      ];
    }

    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      prisma.documentDefinition.findMany({
        where,
        skip,
        take: limit,
        orderBy: [{ targetType: 'asc' }, { name: 'asc' }],
      }),
      prisma.documentDefinition.count({ where }),
    ]);

    return {
      data,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  static async getDocumentDefinitionById(id) {
    const docDef = await prisma.documentDefinition.findFirst({
      where: { id, ...activeRecordsFilter() },
    });

    if (!docDef) {
      const err = new Error(`Document definition with ID "${id}" was not found.`);
      err.status = 404;
      throw err;
    }

    return docDef;
  }

  static async createDocumentDefinition(payload, adminContext = {}) {
    const { targetType, name, code, description, isRequired = false, acceptedFileTypes, maxFileSizeMb = 10, status = 'ACTIVE' } = payload;

    // Check duplicate name per targetType
    const existing = await prisma.documentDefinition.findFirst({
      where: {
        targetType,
        name: { equals: name.trim(), mode: 'insensitive' },
        ...activeRecordsFilter(),
      },
    });

    if (existing) {
      const err = new Error(
        `A ${targetType.toLowerCase()} document definition with the name "${name.trim()}" already exists.`
      );
      err.status = 409;
      throw err;
    }

    const docDef = await prisma.documentDefinition.create({
      data: {
        targetType,
        name: name.trim(),
        code: code?.trim() || null,
        description: description?.trim() || null,
        isRequired,
        acceptedFileTypes: acceptedFileTypes.map((t) => t.trim().toLowerCase()),
        maxFileSizeMb,
        status,
      },
    });

    await logConfigAction({
      adminId: adminContext.id,
      entityType: 'DOCUMENT_DEFINITION',
      entityId: docDef.id,
      action: 'CREATE',
      actor: adminContext.name || adminContext.email || 'ADMIN',
      details: {
        targetType: docDef.targetType,
        name: docDef.name,
        isRequired: docDef.isRequired,
        acceptedFileTypes: docDef.acceptedFileTypes,
        maxFileSizeMb: docDef.maxFileSizeMb,
      },
    });

    return docDef;
  }

  static async updateDocumentDefinition(id, payload, adminContext = {}) {
    const existing = await prisma.documentDefinition.findFirst({
      where: { id, ...activeRecordsFilter() },
    });

    if (!existing) {
      const err = new Error(`Document definition with ID "${id}" was not found.`);
      err.status = 404;
      throw err;
    }

    if (payload.name) {
      const duplicate = await prisma.documentDefinition.findFirst({
        where: {
          id: { not: id },
          targetType: existing.targetType,
          name: { equals: payload.name.trim(), mode: 'insensitive' },
          ...activeRecordsFilter(),
        },
      });

      if (duplicate) {
        const err = new Error(
          `A ${existing.targetType.toLowerCase()} document definition with the name "${payload.name.trim()}" already exists.`
        );
        err.status = 409;
        throw err;
      }
    }

    const updated = await prisma.documentDefinition.update({
      where: { id },
      data: {
        name: payload.name !== undefined ? payload.name.trim() : undefined,
        code: payload.code !== undefined ? payload.code?.trim() || null : undefined,
        description: payload.description !== undefined ? payload.description?.trim() || null : undefined,
        isRequired: payload.isRequired !== undefined ? payload.isRequired : undefined,
        acceptedFileTypes: payload.acceptedFileTypes !== undefined
          ? payload.acceptedFileTypes.map((t) => t.trim().toLowerCase())
          : undefined,
        maxFileSizeMb: payload.maxFileSizeMb !== undefined ? payload.maxFileSizeMb : undefined,
        status: payload.status !== undefined ? payload.status : undefined,
      },
    });

    await logConfigAction({
      adminId: adminContext.id,
      entityType: 'DOCUMENT_DEFINITION',
      entityId: id,
      action: 'UPDATE',
      actor: adminContext.name || adminContext.email || 'ADMIN',
      details: {
        previous: { name: existing.name, isRequired: existing.isRequired, status: existing.status },
        updated: { name: updated.name, isRequired: updated.isRequired, status: updated.status },
      },
    });

    return updated;
  }

  static async toggleDocumentDefinitionStatus(id, newStatus, adminContext = {}) {
    const existing = await prisma.documentDefinition.findFirst({
      where: { id, ...activeRecordsFilter() },
    });

    if (!existing) {
      const err = new Error(`Document definition with ID "${id}" was not found.`);
      err.status = 404;
      throw err;
    }

    const updated = await prisma.documentDefinition.update({
      where: { id },
      data: { status: newStatus },
    });

    await logConfigAction({
      adminId: adminContext.id,
      entityType: 'DOCUMENT_DEFINITION',
      entityId: id,
      action: newStatus === 'ACTIVE' ? 'ACTIVATE' : 'DEACTIVATE',
      actor: adminContext.name || adminContext.email || 'ADMIN',
      details: { name: existing.name, previousStatus: existing.status, newStatus },
    });

    return updated;
  }

  static async deleteDocumentDefinition(id, mode = 'MOVE_TO_TRASH', adminContext = {}) {
    const existing = await prisma.documentDefinition.findUnique({ where: { id } });

    if (!existing || existing.deletedAt !== null) {
      const err = new Error(`Document definition with ID "${id}" was not found.`);
      err.status = 404;
      throw err;
    }

    if (mode === 'DELETE_PERMANENTLY') {
      await prisma.documentDefinition.delete({ where: { id } });

      await logConfigAction({
        adminId: adminContext.id,
        entityType: 'DOCUMENT_DEFINITION',
        entityId: id,
        action: 'DELETE_PERMANENTLY',
        actor: adminContext.name || adminContext.email || 'ADMIN',
        details: { name: existing.name, targetType: existing.targetType },
      });

      return { success: true, message: `Document definition "${existing.name}" permanently deleted.` };
    }

    const softPayload = prepareSoftDeletePayload(adminContext.id);
    await prisma.documentDefinition.update({
      where: { id },
      data: {
        ...softPayload,
        status: 'INACTIVE',
      },
    });

    await logConfigAction({
      adminId: adminContext.id,
      entityType: 'DOCUMENT_DEFINITION',
      entityId: id,
      action: 'MOVE_TO_TRASH',
      actor: adminContext.name || adminContext.email || 'ADMIN',
      details: { name: existing.name, targetType: existing.targetType },
    });

    return { success: true, message: `Document definition "${existing.name}" moved to Trash.` };
  }

  // ==========================================
  // D. Dynamic Recruitment Stages
  // ==========================================

  static async getRecruitmentStages({ status = 'ALL', search, category } = {}) {
    const where = {
      ...activeRecordsFilter(),
    };

    if (status && status !== 'ALL') {
      where.status = status;
    }

    if (category) {
      where.category = category;
    }

    if (search && search.trim()) {
      where.OR = [
        { name: { contains: search.trim(), mode: 'insensitive' } },
        { description: { contains: search.trim(), mode: 'insensitive' } },
      ];
    }

    const stages = await prisma.recruitmentStage.findMany({
      where,
      orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
    });

    return { data: stages, total: stages.length };
  }

  static async getRecruitmentStageById(id) {
    const stage = await prisma.recruitmentStage.findFirst({
      where: { id, ...activeRecordsFilter() },
    });

    if (!stage) {
      const err = new Error(`Recruitment stage with ID "${id}" was not found.`);
      err.status = 404;
      throw err;
    }

    return stage;
  }

  static async createRecruitmentStage(payload, adminContext = {}) {
    const { name, description, category = 'SCREENING', order, status = 'ACTIVE' } = payload;

    const existing = await prisma.recruitmentStage.findFirst({
      where: {
        name: { equals: name.trim(), mode: 'insensitive' },
        ...activeRecordsFilter(),
      },
    });

    if (existing) {
      const err = new Error(`A recruitment stage with the name "${name.trim()}" already exists.`);
      err.status = 409;
      throw err;
    }

    // Determine display order
    let effectiveOrder = order;
    if (effectiveOrder === undefined) {
      const maxStage = await prisma.recruitmentStage.findFirst({
        where: activeRecordsFilter(),
        orderBy: { order: 'desc' },
        select: { order: true },
      });
      effectiveOrder = (maxStage?.order ?? -1) + 1;
    }

    const stage = await prisma.recruitmentStage.create({
      data: {
        name: name.trim(),
        description: description?.trim() || null,
        category,
        order: effectiveOrder,
        status,
      },
    });

    await logConfigAction({
      adminId: adminContext.id,
      entityType: 'RECRUITMENT_STAGE',
      entityId: stage.id,
      action: 'CREATE',
      actor: adminContext.name || adminContext.email || 'ADMIN',
      details: { name: stage.name, category: stage.category, order: stage.order },
    });

    return stage;
  }

  static async updateRecruitmentStage(id, payload, adminContext = {}) {
    const existing = await prisma.recruitmentStage.findFirst({
      where: { id, ...activeRecordsFilter() },
    });

    if (!existing) {
      const err = new Error(`Recruitment stage with ID "${id}" was not found.`);
      err.status = 404;
      throw err;
    }

    if (payload.name) {
      const duplicate = await prisma.recruitmentStage.findFirst({
        where: {
          id: { not: id },
          name: { equals: payload.name.trim(), mode: 'insensitive' },
          ...activeRecordsFilter(),
        },
      });

      if (duplicate) {
        const err = new Error(`A recruitment stage with the name "${payload.name.trim()}" already exists.`);
        err.status = 409;
        throw err;
      }
    }

    const updated = await prisma.recruitmentStage.update({
      where: { id },
      data: {
        name: payload.name !== undefined ? payload.name.trim() : undefined,
        description: payload.description !== undefined ? payload.description?.trim() || null : undefined,
        category: payload.category !== undefined ? payload.category : undefined,
        order: payload.order !== undefined ? payload.order : undefined,
        status: payload.status !== undefined ? payload.status : undefined,
      },
    });

    await logConfigAction({
      adminId: adminContext.id,
      entityType: 'RECRUITMENT_STAGE',
      entityId: id,
      action: 'UPDATE',
      actor: adminContext.name || adminContext.email || 'ADMIN',
      details: {
        previous: { name: existing.name, order: existing.order, status: existing.status },
        updated: { name: updated.name, order: updated.order, status: updated.status },
      },
    });

    return updated;
  }

  static async reorderRecruitmentStages(stagesList, adminContext = {}) {
    // Atomically persist new display orders in database
    await prisma.$transaction(
      stagesList.map((item) =>
        prisma.recruitmentStage.update({
          where: { id: item.id },
          data: { order: item.order },
        })
      )
    );

    await logConfigAction({
      adminId: adminContext.id,
      entityType: 'RECRUITMENT_STAGE',
      entityId: 'BATCH_REORDER',
      action: 'REORDER',
      actor: adminContext.name || adminContext.email || 'ADMIN',
      details: { reorderedCount: stagesList.length, orderMap: stagesList },
    });

    const refreshed = await prisma.recruitmentStage.findMany({
      where: activeRecordsFilter(),
      orderBy: { order: 'asc' },
    });

    return refreshed;
  }

  static async toggleRecruitmentStageStatus(id, newStatus, adminContext = {}) {
    const existing = await prisma.recruitmentStage.findFirst({
      where: { id, ...activeRecordsFilter() },
    });

    if (!existing) {
      const err = new Error(`Recruitment stage with ID "${id}" was not found.`);
      err.status = 404;
      throw err;
    }

    const updated = await prisma.recruitmentStage.update({
      where: { id },
      data: { status: newStatus },
    });

    await logConfigAction({
      adminId: adminContext.id,
      entityType: 'RECRUITMENT_STAGE',
      entityId: id,
      action: newStatus === 'ACTIVE' ? 'ACTIVATE' : 'DEACTIVATE',
      actor: adminContext.name || adminContext.email || 'ADMIN',
      details: { name: existing.name, previousStatus: existing.status, newStatus },
    });

    return updated;
  }

  static async deleteRecruitmentStage(id, mode = 'MOVE_TO_TRASH', adminContext = {}) {
    const existing = await prisma.recruitmentStage.findUnique({ where: { id } });

    if (!existing || existing.deletedAt !== null) {
      const err = new Error(`Recruitment stage with ID "${id}" was not found.`);
      err.status = 404;
      throw err;
    }

    if (existing.isSystem) {
      const err = new Error(`System recruitment stage "${existing.name}" is protected and cannot be deleted.`);
      err.status = 400;
      throw err;
    }

    if (mode === 'DELETE_PERMANENTLY') {
      await prisma.recruitmentStage.delete({ where: { id } });

      await logConfigAction({
        adminId: adminContext.id,
        entityType: 'RECRUITMENT_STAGE',
        entityId: id,
        action: 'DELETE_PERMANENTLY',
        actor: adminContext.name || adminContext.email || 'ADMIN',
        details: { name: existing.name },
      });

      return { success: true, message: `Recruitment stage "${existing.name}" permanently deleted.` };
    }

    const softPayload = prepareSoftDeletePayload(adminContext.id);
    await prisma.recruitmentStage.update({
      where: { id },
      data: {
        ...softPayload,
        status: 'INACTIVE',
      },
    });

    await logConfigAction({
      adminId: adminContext.id,
      entityType: 'RECRUITMENT_STAGE',
      entityId: id,
      action: 'MOVE_TO_TRASH',
      actor: adminContext.name || adminContext.email || 'ADMIN',
      details: { name: existing.name },
    });

    return { success: true, message: `Recruitment stage "${existing.name}" moved to Trash.` };
  }

  // ==========================================
  // E, F, G. Platform Settings
  // ==========================================

  static async getPlatformSettings() {
    let settings = await prisma.platformSetting.findUnique({
      where: { id: 'global' },
    });

    // If uninitialized, create canonical global platform configuration row
    if (!settings) {
      settings = await prisma.platformSetting.create({
        data: {
          id: 'global',
        },
      });
    }

    return settings;
  }

  static async updateCandidateSettings(payload, adminContext = {}) {
    const existing = await this.getPlatformSettings();

    // Verify all file types in acceptedResumeFileTypes
    for (const fileType of payload.acceptedResumeFileTypes) {
      const validation = validateResumeFile(`test_file${fileType}`, null, [fileType]);
      if (!validation.valid && !fileType.startsWith('.') && !fileType.includes('/')) {
        const err = new Error(`Invalid file type or extension: "${fileType}".`);
        err.status = 400;
        throw err;
      }
    }

    const updated = await prisma.platformSetting.update({
      where: { id: 'global' },
      data: {
        acceptedResumeFileTypes: payload.acceptedResumeFileTypes.map((t) => t.trim().toLowerCase()),
        autoApproveCandidateProfiles: payload.autoApproveCandidateProfiles,
        showEmployerContactDetails: payload.showEmployerContactDetails,
        updatedBy: adminContext.id || 'ADMIN',
      },
    });

    await logConfigAction({
      adminId: adminContext.id,
      entityType: 'PLATFORM_SETTING',
      entityId: 'global',
      action: 'UPDATE_CANDIDATE_SETTINGS',
      actor: adminContext.name || adminContext.email || 'ADMIN',
      details: {
        previous: {
          acceptedResumeFileTypes: existing.acceptedResumeFileTypes,
          autoApproveCandidateProfiles: existing.autoApproveCandidateProfiles,
          showEmployerContactDetails: existing.showEmployerContactDetails,
        },
        updated: {
          acceptedResumeFileTypes: updated.acceptedResumeFileTypes,
          autoApproveCandidateProfiles: updated.autoApproveCandidateProfiles,
          showEmployerContactDetails: updated.showEmployerContactDetails,
        },
      },
    });

    return updated;
  }

  static async updateEmployerVisibility(payload, adminContext = {}) {
    const existing = await this.getPlatformSettings();

    const updated = await prisma.platformSetting.update({
      where: { id: 'global' },
      data: {
        showCandidateResumes: payload.showCandidateResumes,
        showCandidateFullName: payload.showCandidateFullName,
        showCandidateEmail: payload.showCandidateEmail,
        showCandidatePhone: payload.showCandidatePhone,
        updatedBy: adminContext.id || 'ADMIN',
      },
    });

    await logConfigAction({
      adminId: adminContext.id,
      entityType: 'PLATFORM_SETTING',
      entityId: 'global',
      action: 'UPDATE_EMPLOYER_VISIBILITY',
      actor: adminContext.name || adminContext.email || 'ADMIN',
      details: {
        previous: {
          showCandidateResumes: existing.showCandidateResumes,
          showCandidateFullName: existing.showCandidateFullName,
          showCandidateEmail: existing.showCandidateEmail,
          showCandidatePhone: existing.showCandidatePhone,
        },
        updated: {
          showCandidateResumes: updated.showCandidateResumes,
          showCandidateFullName: updated.showCandidateFullName,
          showCandidateEmail: updated.showCandidateEmail,
          showCandidatePhone: updated.showCandidatePhone,
        },
      },
    });

    return updated;
  }

  static async updateJobSettings(payload, adminContext = {}) {
    const existing = await this.getPlatformSettings();

    const updated = await prisma.platformSetting.update({
      where: { id: 'global' },
      data: {
        autoApproveJobs: payload.autoApproveJobs,
        updatedBy: adminContext.id || 'ADMIN',
      },
    });

    await logConfigAction({
      adminId: adminContext.id,
      entityType: 'PLATFORM_SETTING',
      entityId: 'global',
      action: 'UPDATE_JOB_SETTINGS',
      actor: adminContext.name || adminContext.email || 'ADMIN',
      details: {
        previous: { autoApproveJobs: existing.autoApproveJobs },
        updated: { autoApproveJobs: updated.autoApproveJobs },
      },
    });

    return updated;
  }

  static async getAuditLogs({ entityType, page = 1, limit = 20 } = {}) {
    const where = {};
    if (entityType) {
      where.entityType = entityType;
    }

    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      prisma.platformConfigAuditLog.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          admin: { select: { id: true, name: true, email: true, role: true } },
        },
      }),
      prisma.platformConfigAuditLog.count({ where }),
    ]);

    return {
      data,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }
}
