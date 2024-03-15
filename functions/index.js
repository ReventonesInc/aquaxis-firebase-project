const functions = require("firebase-functions")
const admin = require('firebase-admin')
const firebase_tools = require('firebase-tools')
const { info } = require("firebase-functions/lib/logger")
const moment = require("moment-timezone")

admin.initializeApp()
const firestore = admin.firestore()
const realtime = admin.database()
const storagedb=admin.storage()
firestore.settings({ ignoreUndefinedProperties: true })

exports.updateDispositivo = functions.database.ref('/dispositivos/{idDispositivo}').onUpdate((change, context) => {

    const dispositivo = context.params.idDispositivo
    if (!change.after.exists()) {
        return null
    }
   
    const datosDisp = change.after.val()
    const user = datosDisp.user

    const docReference = firestore.collection('usuarios').doc(`${user}`)
        .collection('dispositivos').doc(`${dispositivo}`)

    return docReference.set({
        caudal: datosDisp.caudal,
        consumo: datosDisp.consumo,
        actividad: Boolean(datosDisp.estado),
    },{ merge: true })
})

exports.createUserDocument = functions.auth.user().onCreate((user) => {
    const usuario = user.uid;
    const docReference = firestore.collection('usuarios').doc(`${usuario}`);

    const path = `/usuarios/${usuario}`
    console.log(`El usuario ${usuario} ha solicitado crear documento en la ruta ${path}`)

    const notificationInfo = realtime.ref(`notifications/${usuario}/suscrito`)
    notificationInfo.set(false)

    return docReference.set({
            email: user.email,
            primerinicio: true,
            cargofijo: 0,
            cobroconsumo: 0,
            cobrorecoleccion: 0,
            cobrotratamiento: 0,
            canthabhogar: 0,
            cantDispositivos: 0,
            maximodiario: 50
    },{ merge: true })
})

exports.createLog = functions.database.ref('dispositivos/{idDispositivo}/logs/{logId}').onCreate(async(snapshot,context)=>{
    const idDispositivo = context.params.idDispositivo
    const logId = context.params.logId

    const consulta = await realtime.ref(`dispositivos/${idDispositivo}/user`).get()
    const idUser = consulta.val()
    const fechaInicio = await snapshot.child('fechaInicio').val()


    const docGeneralReference = firestore.collection('usuarios').doc(`${idUser}`)
                                .collection('registros').doc(`${idDispositivo}-${logId}`)

    const docDeviceReference = firestore.collection('usuarios').doc(`${idUser}`)
                                .collection('dispositivos').doc(`${idDispositivo}`)
                                .collection('logs').doc(`${logId}`)

    const consultaFirestore = await firestore.collection('usuarios').doc(`${idUser}`)
                                    .collection('dispositivos').doc(`${idDispositivo}`).get()
                                    
    const nickname = consultaFirestore.get('nombre')

    docGeneralReference.set({
        consumo: 0,
        dispositivo: idDispositivo,
        nombre: nickname,
        fechaInicio: new Date(fechaInicio)
    },{merge: true})


    return docDeviceReference.set({
        consumo: 0,
        fechaInicio: new Date(fechaInicio)
    },{merge:true})
})

exports.updateLog = functions.database.ref('dispositivos/{idDispositivo}/logs/{logId}').onUpdate(async(change,context)=>{
    const idDispositivo = context.params.idDispositivo
    const logId = context.params.logId
    const datosLog = change.after.val()

    if (!change.after.exists()) {
        return null
    }

    const consulta = await realtime.ref(`dispositivos/${idDispositivo}/user`).get()
    const idUser = consulta.val()
    const fechaInicio = datosLog.fechaInicio


    const docGeneralReference = firestore.collection('usuarios').doc(`${idUser}`)
                                    .collection('registros').doc(`${idDispositivo}-${logId}`)

    const docDeviceReference = firestore.collection('usuarios').doc(`${idUser}`)
                                    .collection('dispositivos').doc(`${idDispositivo}`)
                                    .collection('logs').doc(`${logId}`)

    if(datosLog.fechaFinal){
        docGeneralReference.set({
            consumo : datosLog.consumo,
            fechaFinal : new Date(datosLog.fechaFinal)
        },{ merge: true})

        return docDeviceReference.set({
            consumo: datosLog.consumo,
            fechaFinal: new Date(datosLog.fechaFinal)
        },{merge:true})
    }
    
    docGeneralReference.set({
        consumo : datosLog.consumo
    },{ merge: true})

    return docDeviceReference.set({
        consumo: datosLog.consumo
    },{merge:true})
    
})

exports.recursiveDelete = functions.runWith({
    timeoutSeconds: 540,
    memory: '2GB'
}).https.onCall(async (data, context) => {
    const path = data.path
    console.log(
        `User ${context.auth.uid} has requested to delete path ${path}`
    )

    await firebase_tools.firestore
        .delete(path, {
        project: process.env.GCLOUD_PROJECT,
        recursive: true,
        yes: true,
        token: functions.config().fb.token
        })

    return {
        path: path
    }
})

exports.excesoDetectado = functions.firestore.document('usuarios/{userUID}/registrosdiarios/{fecha}')
.onUpdate(async (change,context)=>{
    const user = context.params.userUID
    const dataDespues = change.after
    const dataAntes = change.before

    if(dataDespues.get('exceso') && !dataAntes.get('exceso')){
        const userIsSuscribed = await realtime.ref(`notifications/${user}/suscrito`).once('value')
        if(Boolean(userIsSuscribed)){
            const snapshot = await realtime.ref('notifications/'+`${user}`+'/token').once('value')
            const token = snapshot.val()
            const mensaje = {
                notification: {
                    title: '¡Exceso de consumo de agua!',
                    body: 'Has consumido más del límite establecido para el dia hoy',
                }
            }
            return admin.messaging().sendToDevice(token, mensaje)
        }
    }
    return null
})

exports.updateConsumoDiario = functions.firestore.document('usuarios/{userUID}/registros/{registrosID}')
.onUpdate ( async (change, context) => {
    
    const dataDespues = change.after
    const dataAntes = change.before
    const user = context.params.userUID
    const consultaDatosUser = await firestore.collection('usuarios').doc(`${user}`).get()
    const MAX_DIARIO = consultaDatosUser.get('maximodiario')

    if (dataDespues.get('fechaInicio') == undefined) {
        return null    
    }

    var zone = "America/Santiago"
    moment.tz.setDefault(zone);

    const fechaRegistro =  dataDespues.get('fechaInicio').toDate() //Timestamp
    //Momento registro en gmt -4
    const fechaRegistroMoment = moment(fechaRegistro.getTime())
        console.log('FECHA REGISTRO MOMENT       -->', fechaRegistroMoment.toString())
    //----------------------------------------------------------------------------------
    const start = fechaRegistroMoment.clone().startOf("day") //Hora de chile
    const end = fechaRegistroMoment.clone().endOf("day") //Hora de chile
        console.log('FECHA REGISTRO MOMENT START -->', start.toString())
        console.log('FECHA REGISTRO MOMENT END   -->', end.toString())
    //----------------------------------------------------------------------------------

    //Consulta a registros generales con inicio y final del dia para filtrar y sumar el valor del dia
    const refRegistros = firestore.collection('usuarios').doc(`${user}`).collection('registros')
    const consulta = await refRegistros
                .where('fechaInicio', '>=', start.toDate())
                .where('fechaInicio', '<=', end.toDate())
                .get()

    var cont = 0

    consulta.forEach(doc => {
        cont+= doc.get('consumo')
    })

    const docReference = firestore.collection('usuarios').doc(`${user}`)
    .collection('registrosdiarios').doc(`${fechaRegistroMoment.format("DD-MM-YYYY")}`)

    if(cont >= MAX_DIARIO) {
        return docReference.set({
            consumo: cont,
            exceso: true
        },{merge:true})
    }
    else{
        return docReference.set({
            consumo: cont,
            exceso: false
        },{merge:true})
    }

})