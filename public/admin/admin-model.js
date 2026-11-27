const identityFields = ['name', 'shortName', 'studentId', 'gender', 'grade', 'college', 'major', 'className', 'dorm'];
const collator = new Intl.Collator('zh-CN', { numeric: true });

export function buildIndex(students, records) {
    const byStudent = new Map(), byId = new Map();
    for (const record of records) {
        byId.set(record.shareId, record);
        if (!byStudent.has(record.studentId)) byStudent.set(record.studentId, []);
        byStudent.get(record.studentId).push(record);
    }
    const summaries = students.map(student => {
        const history = byStudent.get(student.studentId) || [];
        const latest = history[0];
        return {
            ...latest, ...student, recordCount: history.length,
            updatedAt: latest?.updatedAt || student.updatedAt,
            searchText: `${student.name} ${student.studentId} ${student.className}`.toLowerCase()
        };
    });
    return { byStudent, byId, summaries };
}

export function filterStudents(summaries, query = '', filter = 'all', sort = 'studentId') {
    const text = query.trim().toLowerCase();
    const result = summaries.filter(student => student.searchText.includes(text)
        && (filter === 'all' || (filter === 'disabled' ? student.disabled : student.shareId && !student.disabled)));
    if (sort === 'updated') result.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    else result.sort((a, b) => collator.compare(a.studentId, b.studentId));
    return result;
}

export function paginate(items, page = 1, size = 20) {
    const pages = Math.max(1, Math.ceil(items.length / size));
    const current = Math.min(pages, Math.max(1, Number(page) || 1));
    const offset = (current - 1) * size;
    return { items: items.slice(offset, offset + size), page: current, pages, total: items.length,
        start: items.length ? offset + 1 : 0, end: Math.min(offset + size, items.length) };
}

// Only apply confirmed server responses. Equal creation times keep insertion order.
export function mergeRecordData(data, incoming, { profile = true } = {}) {
    const previous = data.records.find(record => record.shareId === incoming.shareId);
    const record = { ...previous, ...incoming };
    const history = data.records.filter(item => item.studentId === record.studentId);
    const index = history.findIndex(item => item.shareId === record.shareId);
    if (index === -1) history.unshift(record);
    else history[index] = record;
    history.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    const records = [
        ...history.slice(0, 100),
        ...data.records.filter(item => item.studentId !== record.studentId && item.shareId !== record.shareId)
    ];
    let students = data.students;
    if (profile) {
        const student = students.find(item => item.studentId === record.studentId);
        const identity = Object.fromEntries(identityFields.map(key => [key, record[key]]));
        const changed = !student || identityFields.some(key => student[key] !== record[key]);
        const next = { ...student, ...identity, createdAt: student?.createdAt || record.createdAt,
            updatedAt: !previous || changed ? record.updatedAt : student.updatedAt };
        students = student ? students.map(item => item.studentId === record.studentId ? next : item) : [...students, next];
    }
    return { students, records };
}
