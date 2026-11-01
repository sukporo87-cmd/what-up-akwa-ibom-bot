// ============================================================
// FILE: src/utils/ng-places.js
// Turns whatever a player typed as their "city" into a tidy place:
// a Nigerian state (and town, when we can tell), or a country (and
// city) abroad.
//
//   resolvePlace('Ughell delta state')  -> Delta, city Ughelli
//   resolvePlace('ph')                  -> Rivers, city Port Harcourt
//   resolvePlace('Gwarinpa Abuja')      -> FCT, city Gwarinpa
//   resolvePlace('Houston TX')          -> United States, Texas, Houston
//   resolvePlace('Karu')                -> AMBIGUOUS (FCT or Nasarawa)
//
// Nothing here guesses past what the text supports. A name that belongs
// to more than one state, or nothing we recognise, comes back as
// 'ambiguous' / 'unmatched' for an admin to decide once.
//
// The 774 LGAs come from the npm package "nigerian-states-and-lgas"
// (ISC licence), checked state by state against the official counts; its
// one error ("Kastina") is corrected. Towns, neighbourhoods, nicknames and
// places abroad are curated here.
// ============================================================
'use strict';

const LGAS = {
  "Abia": ["Aba North","Aba South","Arochukwu","Bende","Ikwuano","Isiala Ngwa North","Isiala Ngwa South","Isuikwuato","Obi Ngwa","Ohafia","Osisioma","Ugwunagbo","Ukwa East","Ukwa West","Umuahia North","Umuahia South","Umu Nneochi"],
  "Adamawa": ["Demsa","Fufure","Ganye","Gayuk","Girei","Gombi","Hong","Jada","Lamurde","Madagali","Maiha","Mayo Belwa","Michika","Mubi North","Mubi South","Numan","Shelleng","Song","Toungo","Yola North","Yola South"],
  "Akwa Ibom": ["Abak","Eastern Obolo","Eket","Esit Eket","Essien Udim","Etim Ekpo","Etinan","Ibeno","Ibesikpo Asutan","Ibiono-Ibom","Ika","Ikono","Ikot Abasi","Ikot Ekpene","Ini","Itu","Mbo","Mkpat-Enin","Nsit-Atai","Nsit-Ibom","Nsit-Ubium","Obot Akara","Okobo","Onna","Oron","Oruk Anam","Udung-Uko","Ukanafun","Uruan","Urue-Offong/Oruko","Uyo"],
  "Anambra": ["Aguata","Anambra East","Anambra West","Anaocha","Awka North","Awka South","Ayamelum","Dunukofia","Ekwusigo","Idemili North","Idemili South","Ihiala","Njikoka","Nnewi North","Nnewi South","Ogbaru","Onitsha North","Onitsha South","Orumba North","Orumba South","Oyi"],
  "Bauchi": ["Alkaleri","Bauchi","Bogoro","Damban","Darazo","Dass","Gamawa","Ganju/Ganjuwa","Giade","Itas/Gadau","Jama'are","Katagum","Kirfi","Misau","Ningi","Shira","Tafawa Balewa","Toro","Warji","Zaki"],
  "Bayelsa": ["Brass","Ekere/Ekeremor","Kolokuma/Opokuma","Nembe","Ogbia","Sagba/Sagbama","Southern Ijaw","Yenagoa"],
  "Benue": ["Ado","Agatu","Apa","Buruku","Gboko","Guma","Gwer East","Gwer West","Katsina-Ala","Konshisha","Kwande","Logo","Makurdi","Obi","Ogbadibo","Ohimini","Oju","Okpokwu","Oturkpo","Tarka","Ukum","Ushongo","Vandeikya"],
  "Borno": ["Abadam","Askira/Uba","Bama","Bayo","Biu","Chibok","Damboa","Dikwa","Gubio","Guzamala","Gwoza","Hawul","Jere","Kaga","Kala/Balge","Konduga","Kukawa","Kwaya Kusar","Mafa","Magumeri","Maiduguri","Marte","Mobbar","Monguno","Ngala","Nganzai","Shani"],
  "Cross River": ["Abi","Akamkpa","Akpabuyo","Bakassi","Bekwarra","Biase","Boki","Calabar Municipal","Calabar South","Etung","Ikom","Obanliku","Obubra","Obudu","Odukpani","Ogoja","Yakuur","Yala"],
  "Delta": ["Aniocha North","Aniocha South","Bomadi","Burutu","Ethiope East","Ethiope West","Ika North East","Ika South","Isoko North","Isoko South","Ndokwa East","Ndokwa West","Okpe","Oshimili North","Oshimili South","Patani","Sapele","Udu","Ughelli North","Ughelli South","Ukwuani","Uvwie","Warri North","Warri South","Warri South West"],
  "Ebonyi": ["Abakaliki","Afikpo North","Afikpo South","Ebonyi","Ezza North","Ezza South","Ikwo","Ishielu","Ivo","Izzi","Ohaozara","Ohaukwu","Onicha"],
  "Edo": ["Akoko-Edo","Egor","Esan Central","Esan North-East","Esan South-East","Esan West","Etsako Central","Etsako East","Etsako West","Igueben","Ikpoba Okha","Orhionmwon","Oredo","Ovia North-East","Ovia South-West","Owan East","Owan West","Uhunmwonde"],
  "Ekiti": ["Ado Ekiti","Efon","Ekiti East","Ekiti South-West","Ekiti West","Emure","Gbonyin","Ido Osi","Ijero","Ikere","Ikole","Ilejemeje","Irepodun/Ifelodun","Ise/Orun","Moba","Oye"],
  "Enugu": ["Aninri","Awgu","Enugu East","Enugu North","Enugu South","Ezeagu","Igbo Etiti","Igbo Eze North","Igbo Eze South","Isi Uzo","Nkanu East","Nkanu West","Nsukka","Oji River","Udenu","Udi","Uzo-Uwani"],
  "Gombe": ["Akko","Balanga","Billiri","Dukku","Funakaye","Gombe","Kaltungo","Kwami","Nafada","Shongom","Yamaltu/Deba"],
  "Imo": ["Aboh Mbaise","Ahiazu Mbaise","Ehime Mbano","Ezinihitte","Ideato North","Ideato South","Ihitte/Uboma","Ikeduru","Isiala Mbano","Isu","Mbaitoli","Ngor Okpala","Njaba","Nkwerre","Nwangele","Obowo","Oguta","Ohaji/Egbema","Okigwe","Orlu","Orsu","Oru East","Oru West","Owerri Municipal","Owerri North","Owerri West","Unuimo"],
  "Jigawa": ["Auyo","Babura","Biriniwa","Birnin Kudu","Buji","Dutse","Gagarawa","Garki","Gumel","Guri","Gwaram","Gwiwa","Hadejia","Jahun","Kafin Hausa","Kaugama","Kazaure","Kiri Kasama","Kiyawa","Maigatari","Malam Madori","Miga","Ringim","Roni","Sule Tankarkar","Taura","Yankwashi"],
  "Kaduna": ["Birnin Gwari","Chikun","Giwa","Igabi","Ikara","Jaba","Jema'a","Kachia","Kaduna North","Kaduna South","Kagarko","Kajuru","Kaura","Kauru","Kubau","Kudan","Lere","Makarfi","Sabon Gari","Sanga","Soba","Zangon Kataf","Zaria"],
  "Kano": ["Ajingi","Albasu","Bagwai","Bebeji","Bichi","Bunkure","Dala","Dambatta","Dawakin Kudu","Dawakin Tofa","Doguwa","Fagge","Gabasawa","Garko","Garun Mallam","Gaya","Gezawa","Gwale","Gwarzo","Kabo","Kano Municipal","Karaye","Kibiya","Kiru","Kumbotso","Kunchi","Kura","Madobi","Makoda","Minjibir","Nasarawa","Rano","Rimin Gado","Rogo","Shanono","Sumaila","Takai","Tarauni","Tofa","Tsanyawa","Tudun Wada","Ungogo","Warawa","Wudil"],
  "Katsina": ["Bakori","Batagarawa","Batsari","Baure","Bindawa","Charanchi","Dandume","Danja","Dan Musa","Daura","Dutsi","Dutsin Ma","Faskari","Funtua","Ingawa","Jibia","Kafur","Kaita","Kankara","Kankia","Katsina","Kurfi","Kusada","Mai'Adua","Malumfashi","Mani","Mashi","Matazu","Musawa","Rimi","Sabuwa","Safana","Sanda/Sandamu","Zango"],
  "Kebbi": ["Aleiro","Arewa","Argungu","Augie","Bagudo","Birnin Kebbi","Bunza","Dandi","Fakai","Gwandu","Jega","Kalgo","Koko/Besse","Maiya/Maiyama","Ngaski","Sakaba","Shanga","Suru","Danko-Wasagu","Yauri","Zuru"],
  "Kogi": ["Adavi","Ajaokuta","Ankpa","Bassa","Dekina","Ibaji","Idah","Igalamela Odolu","Ijumu","Kabba/Bunu","Kogi","Lokoja","Mopa Muro","Ofu","Ogori/Magongo","Okehi","Okene","Olamaboro","Omala","Yagba East","Yagba West"],
  "Kwara": ["Asa","Baruten","Edu","Ekiti","Ifelodun","Ilorin East","Ilorin South","Ilorin West","Irepodun","Isin","Kaiama","Moro","Offa","Oke Ero","Oyun","Pategi"],
  "Lagos": ["Agege","Ajeromi-Ifelodun","Alimosho","Amuwo-Odofin","Apapa","Badagry","Epe","Eti Osa","Ibeju-Lekki","Ifako-Ijaiye","Ikeja","Ikorodu","Kosofe","Lagos Island","Lagos Mainland","Mushin","Ojo","Oshodi-Isolo","Shomolu","Surulere"],
  "Nasarawa": ["Akwanga","Awe","Doma","Karu","Keana","Keffi","Kokona","Lafia","Nasarawa","Nasarawa Egon","Obi","Toto","Wamba"],
  "Niger": ["Agaie","Agwara","Bida","Borgu","Bosso","Chanchaga","Edati","Gbako","Gurara","Katcha","Kontagora","Lapai","Lavun","Magama","Mariga","Mashegu","Mokwa","Moya","Paikoro","Rafi","Rijau","Shiroro","Suleja","Tafa","Wushishi"],
  "Ogun": ["Abeokuta North","Abeokuta South","Ado-Odo/Ota","Ewekoro","Ifo","Ijebu East","Ijebu North","Ijebu North East","Ijebu Ode","Ikenne","Imeko Afon","Ipokia","Obafemi/Obafemi Owode","Odeda","Odogbolu","Ogun Waterside","Remo North","Shaga/Shagamu","Yewa North","Yewa South"],
  "Ondo": ["Akoko North-East","Akoko North-West","Akoko South-East","Akoko South-West","Akure North","Akure South","Ese Odo","Idanre","Ifedore","Ilaje","Ile Oluji/Okeigbo","Irele","Odigbo","Okitipupa","Ondo East","Ondo West","Ose","Owo"],
  "Osun": ["Aiyedaade","Aiyedire","Atakunmosa East","Atakunmosa West","Boluwaduro","Boripe","Ede North","Ede South","Egbedore","Ejigbo","Ife Central","Ife East","Ife North","Ife South","Ifedayo","Ifelodun","Ila","Ilesa East","Ilesa West","Irepodun","Irewole","Isokan","Iwo","Obokun","Odo Otin","Ola Oluwa","Olorunda","Oriade","Orolu","Osogbo"],
  "Oyo": ["Afijio","Akinyele","Atiba","Atisbo","Egbeda","Ibadan North","Ibadan North-East","Ibadan North-West","Ibadan South-East","Ibadan South-West","Ibarapa Central","Ibarapa East","Ibarapa North","Ido","Irepo","Iseyin","Itesiwaju","Iwajowa","Kajola","Lagelu","Ogbomosho North","Ogbomosho South","Ogo Oluwa","Olorunsogo","Oluyole","Ona Ara","Orelope","Ori Ire","Oyo East","Oyo West","Saki East","Saki West","Surulere"],
  "Plateau": ["Bokkos","Barkin Ladi","Bassa","Jos East","Jos North","Jos South","Kanam","Kanke","Langtang North","Langtang South","Mangu","Mikang","Pankshin","Qua'an Pan","Riyom","Shendam","Wase"],
  "Rivers": ["Abua/Odual","Ahoada East","Ahoada West","Akuku-Toru","Andoni","Asari-Toru","Bonny","Degema","Eleme","Emuoha","Etche","Gokana","Ikwerre","Khana","Obio/Akpor","Ogba/Egbema/Ndoni","Ogu/Bolo","Okrika","Omuma","Opobo/Nkoro","Oyigbo","Port Harcourt","Tai"],
  "Sokoto": ["Binji","Bodinga","Dange Shuni","Gada","Goron/Goronyo","Gudu","Gwadabawa","Illela","Isa","Kebbe","Kware","Rabah","Sabon Birni","Shagari","Silame","Sokoto North","Sokoto South","Tambuwal","Tangaza","Tureta","Wamako","Wurno","Yabo"],
  "Taraba": ["Ardo Kola","Bali","Donga","Gashaka","Gassol","Ibi","Jalingo","Karim Lamido","Kumi","Lau","Sardauna","Takum","Ussa","Wukari","Yorro","Zing"],
  "Yobe": ["Bade","Bursari","Damaturu","Fika","Fune","Geidam","Gujba","Gulani","Jakusko","Karasuwa","Machina","Nangere","Nguru","Potiskum","Tarmuwa","Yunusari","Yusufari"],
  "Zamfara": ["Anka","Bakura","Birnin Magaji/Kiyaw","Bukkuyum","Bungudu","Chafe","Gummi","Gusau","Kaura Namoda","Maradun","Maru","Shinkafi","Talata Mafara","Zurmi"],
  "FCT": ["Abaji","Abuja Municipal Area Council","Bwari","Gwagwalada","Kuje","Kwali"],
};

// The display name for each state. FCT shows as "FCT (Abuja)".
const STATE_DISPLAY = { FCT: 'FCT (Abuja)' };
const stateLabel = (s) => STATE_DISPLAY[s] || s;

// Other ways people write a state name. Keys are squashed (letters and
// digits only), as everything is matched squashed.
const STATE_ALIASES = {
  'Akwa Ibom': ['akwaibom', 'akwaiboms', 'akwaibomstate'],
  'Cross River': ['crossriver', 'crossrivers'],
  'Nasarawa': ['nassarawa', 'nasarawastate'],
  'Katsina': ['kastina'],
  'FCT': ['fct', 'federalcapitalterritory', 'federalcapital', 'fctabuja', 'abujafct'],
  'Lagos': ['lasgidi', 'eko', 'lagosstate', 'lag'],
  'Plateau': ['plateu'],
};
// Very short forms are only trusted when they are the WHOLE answer.
const WHOLE_ANSWER_ONLY = {
  'aks': { state: 'Akwa Ibom' }, 'crs': { state: 'Cross River' },
  'ph': { state: 'Rivers', city: 'Port Harcourt' }, 'phc': { state: 'Rivers', city: 'Port Harcourt' },
  'vi': { state: 'Lagos', city: 'Victoria Island' }, 'abj': { state: 'FCT', city: 'Abuja' },
  'lag': { state: 'Lagos' }, 'kd': { state: 'Kaduna', city: 'Kaduna' },
};

// Towns, cities and neighbourhoods that are not LGA names themselves (or are
// commonly written differently), by state. Capitals first.
const TOWNS = {
  'Abia': ['Umuahia', 'Aba', 'Ohafia', 'Arochukwu', 'Bende', 'Umunneochi', 'Isuochi'],
  'Adamawa': ['Yola', 'Jimeta', 'Mubi', 'Numan', 'Ganye', 'Michika'],
  'Akwa Ibom': ['Uyo', 'Eket', 'Ikot Ekpene', 'Oron', 'Abak', 'Ikot Abasi', 'Itu'],
  'Anambra': ['Awka', 'Onitsha', 'Nnewi', 'Ekwulobia', 'Ihiala', 'Nkpor', 'Obosi', 'Ogidi', 'Agulu', 'Ozubulu', 'Oba', 'Umunze', 'Igbariam'],
  'Bauchi': ['Bauchi', 'Azare', 'Misau', 'Jamaare'],
  'Bayelsa': ['Yenagoa', 'Amassoma', 'Brass', 'Nembe', 'Ogbia', 'Sagbama', 'Kaiama'],
  'Benue': ['Makurdi', 'Gboko', 'Otukpo', 'Katsina-Ala', 'Zaki Biam', 'Adikpo', 'Vandeikya', 'Aliade'],
  'Borno': ['Maiduguri', 'Biu', 'Bama', 'Monguno', 'Dikwa', 'Gwoza'],
  'Cross River': ['Calabar', 'Ogoja', 'Ikom', 'Obudu', 'Ugep', 'Akamkpa'],
  'Delta': ['Asaba', 'Warri', 'Sapele', 'Ughelli', 'Agbor', 'Abraka', 'Effurun', 'Oleh', 'Ozoro', 'Kwale', 'Oghara', 'Ogwashi-Uku', 'Issele-Uku', 'Obiaruku', 'Okpanam', 'Isoko', 'Ekpan'],
  'Ebonyi': ['Abakaliki', 'Afikpo', 'Onueke', 'Ishiagu'],
  'Edo': ['Benin City', 'Benin', 'Ekpoma', 'Auchi', 'Uromi', 'Irrua', 'Igarra', 'Ubiaja', 'Sabongida-Ora', 'Okada', 'Ugbowo'],
  'Ekiti': ['Ado-Ekiti', 'Ado Ekiti', 'Ikere', 'Ijero', 'Ikole', 'Ise', 'Emure', 'Efon', 'Aramoko', 'Oye', 'Omuo', 'Otun', 'Iyin'],
  'Enugu': ['Enugu', 'Nsukka', 'Agbani', 'Oji River', 'Awgu', 'Emene', 'Ninth Mile'],
  'Gombe': ['Gombe', 'Kumo', 'Billiri', 'Kaltungo', 'Dukku'],
  'Imo': ['Owerri', 'Okigwe', 'Orlu', 'Mbaise', 'Oguta', 'Mbano', 'Nkwerre', 'Mgbidi', 'Umuaka'],
  'Jigawa': ['Hadejia', 'Kazaure', 'Gumel', 'Ringim', 'Birnin Kudu'],
  'Kaduna': ['Kaduna', 'Zaria', 'Kafanchan', 'Kagoro', 'Zonkwa', 'Saminaka', 'Kachia', 'Barnawa', 'Kakuri'],
  'Kano': ['Kano', 'Wudil', 'Rano', 'Bichi', 'Gaya', 'Kura', 'Sabon Gari'],
  'Katsina': ['Katsina', 'Funtua', 'Daura', 'Malumfashi', 'Dutsin-Ma', 'Kankia'],
  'Kebbi': ['Birnin Kebbi', 'Argungu', 'Yauri', 'Zuru', 'Jega'],
  'Kogi': ['Lokoja', 'Okene', 'Idah', 'Anyigba', 'Kabba', 'Ankpa', 'Ajaokuta', 'Obajana', 'Egbe', 'Isanlu'],
  'Kwara': ['Ilorin', 'Offa', 'Omu-Aran', 'Jebba', 'Lafiagi', 'Patigi', 'Share', 'Esie', 'Malete'],
  'Lagos': ['Ikeja', 'Lekki', 'Ajah', 'Ikoyi', 'Victoria Island', 'Yaba', 'Festac', 'Festac Town', 'Ikotun', 'Egbeda', 'Ogba',
            'Magodo', 'Gbagada', 'Ojota', 'Maryland', 'Ketu', 'Ojodu', 'Berger', 'Isolo', 'Igando', 'Idimu', 'Ipaja',
            'Ayobo', 'Sangotedo', 'Ilupeju', 'Oshodi', 'Ebute Metta', 'Obalende', 'Oniru', 'Iyana Ipaja', 'Ijora',
            'Okokomaiko', 'Satellite Town', 'Egbe', 'Mile 2', 'Ijanikin', 'Abule Egba', 'Ogudu', 'Ilasamaja', 'Ikota', 'Ogombo',
            'Lakowe', 'Awoyaya', 'Bogije', 'Ibeju', 'Akoka', 'Ebute', 'Ojuelegba', 'Iyana Oworo', 'Ogudu', 'Agidingbi',
            'Alausa', 'Opebi', 'Allen', 'Omole', 'Ejigbo', 'Isheri Olofin', 'Badore', 'Chevron', 'Osapa', 'Agungi', 'Ikate', 'Jakande'],
  'Nasarawa': ['Lafia', 'Keffi', 'Akwanga', 'Mararaba', 'Masaka', 'New Karu', 'Doma', 'Wamba', 'Auta Balefi', 'One Man Village'],
  'Niger': ['Minna', 'Bida', 'Suleja', 'Kontagora', 'New Bussa', 'Lapai', 'Mokwa', 'Agaie', 'Madalla'],
  'Ogun': ['Abeokuta', 'Ijebu-Ode', 'Ijebu Ode', 'Sagamu', 'Shagamu', 'Ota', 'Sango Ota', 'Sango', 'Ifo', 'Mowe', 'Ibafo',
           'Agbara', 'Ilaro', 'Ijebu-Igbo', 'Ago-Iwoye', 'Ilishan', 'Iperu', 'Owode', 'Ogere', 'Magboro', 'Arepo', 'Akute', 'Ilisan'],
  'Ondo': ['Akure', 'Ondo', 'Owo', 'Ikare', 'Okitipupa', 'Ore', 'Idanre', 'Igbokoda', 'Oka'],
  'Osun': ['Osogbo', 'Oshogbo', 'Ile-Ife', 'Ile Ife', 'Ife', 'Ilesa', 'Ilesha', 'Ede', 'Iwo', 'Ikirun', 'Ila', 'Ikire', 'Inisa', 'Ipetumodu'],
  'Oyo': ['Ibadan', 'Ogbomoso', 'Ogbomosho', 'Oyo', 'Iseyin', 'Saki', 'Shaki', 'Igboho', 'Igbo-Ora', 'Eruwa', 'Kishi', 'Okeho', 'Lanlate', 'Bodija', 'Ojoo', 'Moniya', 'Apata'],
  'Plateau': ['Jos', 'Bukuru', 'Pankshin', 'Shendam', 'Langtang', 'Barkin Ladi', 'Vom', 'Mangu'],
  'Rivers': ['Port Harcourt', 'Portharcourt', 'Port-Harcourt', 'Rumuokoro', 'Rumuola', 'Choba', 'Trans Amadi', 'Onne',
             'Bori', 'Bonny', 'Okrika', 'Oyigbo', 'Omoku', 'Ahoada', 'Elelenwo', 'Woji', 'Rumuigbo', 'Diobu', 'Borokiri',
             'Rumuomasi', 'Aluu', 'Igwuruta', 'Rukpokwu', 'Eliozu', 'Rumuodara', 'Rumuokwuta', 'Eleme'],
  'Sokoto': ['Sokoto', 'Tambuwal', 'Wurno', 'Gwadabawa', 'Illela'],
  'Taraba': ['Jalingo', 'Wukari', 'Takum', 'Bali', 'Gembu', 'Serti', 'Zing'],
  'Yobe': ['Damaturu', 'Potiskum', 'Nguru', 'Gashua', 'Geidam'],
  'Zamfara': ['Gusau', 'Kaura Namoda', 'Talata Mafara', 'Anka', 'Tsafe'],
  'FCT': ['Abuja', 'Garki', 'Wuse', 'Maitama', 'Asokoro', 'Gwarinpa', 'Gwarimpa', 'Kubwa', 'Lugbe', 'Jabi', 'Utako', 'Nyanya',
          'Jikwoyi', 'Kurudu', 'Apo', 'Lokogoma', 'Galadimawa', 'Kado', 'Life Camp', 'Katampe', 'Mpape', 'Dei-Dei', 'Zuba',
          'Gwagwa', 'Idu', 'Durumi', 'Wuye', 'Mabushi', 'Guzape', 'Jahi', 'Karmo', 'Dawaki', 'Karu Site', 'Karshi', 'Orozo',
          'Kuchingoro', 'Piwoyi', 'Kagini', 'Dutse Alhaji', 'Dutse Makaranta', 'Central Area', 'Wuse 2', 'Area 1',
          'Kuje', 'Bwari', 'Gwagwalada', 'Kwali', 'Abaji', 'Kabusa', 'Karu', 'Dutse'],
};
// Two that belong in two places at once — kept so both are found, which
// makes them ambiguous on purpose: "Karu" is a district of Abuja AND an LGA
// of Nasarawa; "Dutse" is a district of Abuja AND the capital of Jigawa.
// An admin decides each once and the decision sticks.
TOWNS['Jigawa'].unshift('Dutse');

// Countries, with the ways Nigerian players tend to write them.
// "Niger" and "Benin" alone mean the Nigerian state / Benin City; only the
// "Republic" forms (or their cities) mean the countries.
const COUNTRIES = {
  'United Kingdom': ['uk', 'unitedkingdom', 'england', 'britain', 'greatbritain', 'gb', 'scotland', 'wales', 'northernireland'],
  'United States': ['usa', 'us', 'unitedstates', 'unitedstatesofamerica', 'america', 'states'],
  'Canada': ['canada'], 'Ireland': ['ireland', 'republicofireland'], 'Ghana': ['ghana'],
  'Benin': ['beninrepublic', 'republicofbenin'], 'Niger': ['nigerrepublic', 'republicofniger'],
  'Togo': ['togo'], 'Cameroon': ['cameroon', 'cameroun'], 'Chad': ['chad'], 'Senegal': ['senegal'],
  "Côte d'Ivoire": ['ivorycoast', 'cotedivoire'], 'Liberia': ['liberia'], 'Sierra Leone': ['sierraleone'],
  'Gambia': ['gambia', 'thegambia'], 'Mali': ['mali'], 'Burkina Faso': ['burkinafaso'], 'Guinea': ['guinea'],
  'Equatorial Guinea': ['equatorialguinea'], 'Gabon': ['gabon'], 'Congo': ['congo', 'drc', 'drcongo'],
  'Kenya': ['kenya'], 'Uganda': ['uganda'], 'Tanzania': ['tanzania'], 'Rwanda': ['rwanda'], 'Ethiopia': ['ethiopia'],
  'South Africa': ['southafrica', 'sa', 'rsa'], 'Zambia': ['zambia'], 'Zimbabwe': ['zimbabwe'], 'Botswana': ['botswana'],
  'Namibia': ['namibia'], 'Egypt': ['egypt'], 'Morocco': ['morocco'], 'Algeria': ['algeria'], 'Tunisia': ['tunisia'],
  'Libya': ['libya'], 'Sudan': ['sudan'],
  'United Arab Emirates': ['uae', 'unitedarabemirates', 'emirates'], 'Qatar': ['qatar'], 'Saudi Arabia': ['saudiarabia', 'saudi', 'ksa'],
  'Kuwait': ['kuwait'], 'Oman': ['oman'], 'Bahrain': ['bahrain'], 'Israel': ['israel'], 'Turkey': ['turkey', 'turkiye'],
  'Germany': ['germany'], 'France': ['france'], 'Netherlands': ['netherlands', 'holland'], 'Belgium': ['belgium'],
  'Italy': ['italy'], 'Spain': ['spain'], 'Portugal': ['portugal'], 'Switzerland': ['switzerland'], 'Austria': ['austria'],
  'Sweden': ['sweden'], 'Norway': ['norway'], 'Denmark': ['denmark'], 'Finland': ['finland'], 'Poland': ['poland'],
  'Russia': ['russia'], 'Ukraine': ['ukraine'], 'Cyprus': ['cyprus', 'northcyprus'], 'Malta': ['malta'], 'Greece': ['greece'],
  'Hungary': ['hungary'], 'Czechia': ['czechia', 'czechrepublic'], 'Romania': ['romania'],
  'China': ['china'], 'Japan': ['japan'], 'South Korea': ['southkorea', 'korea'], 'India': ['india'], 'Pakistan': ['pakistan'],
  'Malaysia': ['malaysia'], 'Singapore': ['singapore'], 'Indonesia': ['indonesia'], 'Philippines': ['philippines'],
  'Thailand': ['thailand'], 'Vietnam': ['vietnam'],
  'Australia': ['australia'], 'New Zealand': ['newzealand'],
  'Brazil': ['brazil'], 'Mexico': ['mexico'], 'Jamaica': ['jamaica'], 'Trinidad and Tobago': ['trinidad', 'trinidadandtobago'],
  'Nigeria': ['nigeria', 'naija', 'nigerian', 'ng', 'nga'],
};

// US states and Canadian provinces listed below as places in their own right.
const REGION_ONLY = new Set(['Texas', 'California', 'Maryland', 'New Jersey', 'Florida', 'Illinois', 'Massachusetts',
  'Minnesota', 'Virginia', 'North Carolina', 'Pennsylvania', 'Ontario', 'Alberta', 'Manitoba']);
// Cities and regions abroad: [name, region or null, country].
const ABROAD = [
  ['London', 'England', 'United Kingdom'], ['Manchester', 'England', 'United Kingdom'], ['Birmingham', 'England', 'United Kingdom'],
  ['Leeds', 'England', 'United Kingdom'], ['Liverpool', 'England', 'United Kingdom'], ['Sheffield', 'England', 'United Kingdom'],
  ['Bristol', 'England', 'United Kingdom'], ['Leicester', 'England', 'United Kingdom'], ['Nottingham', 'England', 'United Kingdom'],
  ['Coventry', 'England', 'United Kingdom'], ['Luton', 'England', 'United Kingdom'], ['Reading', 'England', 'United Kingdom'],
  ['Milton Keynes', 'England', 'United Kingdom'], ['Bradford', 'England', 'United Kingdom'], ['Newcastle', 'England', 'United Kingdom'],
  ['Southampton', 'England', 'United Kingdom'], ['Portsmouth', 'England', 'United Kingdom'], ['Cambridge', 'England', 'United Kingdom'],
  ['Oxford', 'England', 'United Kingdom'], ['Glasgow', 'Scotland', 'United Kingdom'], ['Edinburgh', 'Scotland', 'United Kingdom'],
  ['Aberdeen', 'Scotland', 'United Kingdom'], ['Dundee', 'Scotland', 'United Kingdom'], ['Cardiff', 'Wales', 'United Kingdom'],
  ['Swansea', 'Wales', 'United Kingdom'], ['Belfast', 'Northern Ireland', 'United Kingdom'],
  ['Dublin', null, 'Ireland'], ['Cork', null, 'Ireland'], ['Galway', null, 'Ireland'], ['Limerick', null, 'Ireland'],
  ['New York', 'New York', 'United States'], ['Houston', 'Texas', 'United States'], ['Dallas', 'Texas', 'United States'],
  ['Austin', 'Texas', 'United States'], ['San Antonio', 'Texas', 'United States'], ['Atlanta', 'Georgia', 'United States'],
  ['Chicago', 'Illinois', 'United States'], ['Los Angeles', 'California', 'United States'], ['San Francisco', 'California', 'United States'],
  ['Washington DC', 'District of Columbia', 'United States'], ['Baltimore', 'Maryland', 'United States'], ['Boston', 'Massachusetts', 'United States'],
  ['Philadelphia', 'Pennsylvania', 'United States'], ['Miami', 'Florida', 'United States'], ['Orlando', 'Florida', 'United States'],
  ['Seattle', 'Washington', 'United States'], ['Newark', 'New Jersey', 'United States'], ['Charlotte', 'North Carolina', 'United States'],
  ['Minneapolis', 'Minnesota', 'United States'], ['Detroit', 'Michigan', 'United States'], ['Phoenix', 'Arizona', 'United States'],
  ['Las Vegas', 'Nevada', 'United States'],
  ['Texas', 'Texas', 'United States'], ['California', 'California', 'United States'], ['Maryland', 'Maryland', 'United States'],
  ['New Jersey', 'New Jersey', 'United States'], ['Florida', 'Florida', 'United States'], ['Illinois', 'Illinois', 'United States'],
  ['Massachusetts', 'Massachusetts', 'United States'], ['Minnesota', 'Minnesota', 'United States'], ['Virginia', 'Virginia', 'United States'],
  ['North Carolina', 'North Carolina', 'United States'], ['Pennsylvania', 'Pennsylvania', 'United States'],
  ['Toronto', 'Ontario', 'Canada'], ['Ottawa', 'Ontario', 'Canada'], ['Mississauga', 'Ontario', 'Canada'], ['Brampton', 'Ontario', 'Canada'],
  ['Hamilton', 'Ontario', 'Canada'], ['Windsor', 'Ontario', 'Canada'], ['Calgary', 'Alberta', 'Canada'], ['Edmonton', 'Alberta', 'Canada'],
  ['Winnipeg', 'Manitoba', 'Canada'], ['Vancouver', 'British Columbia', 'Canada'], ['Montreal', 'Quebec', 'Canada'],
  ['Halifax', 'Nova Scotia', 'Canada'], ['Saskatoon', 'Saskatchewan', 'Canada'], ['Regina', 'Saskatchewan', 'Canada'],
  ['Ontario', 'Ontario', 'Canada'], ['Alberta', 'Alberta', 'Canada'], ['Manitoba', 'Manitoba', 'Canada'],
  ['Accra', 'Greater Accra', 'Ghana'], ['Kumasi', 'Ashanti', 'Ghana'], ['Tema', 'Greater Accra', 'Ghana'], ['Takoradi', 'Western', 'Ghana'],
  ['Lome', null, 'Togo'], ['Cotonou', null, 'Benin'], ['Porto-Novo', null, 'Benin'], ['Niamey', null, 'Niger'],
  ['Douala', null, 'Cameroon'], ['Yaounde', null, 'Cameroon'], ['Buea', null, 'Cameroon'], ['Dakar', null, 'Senegal'],
  ['Abidjan', null, "Côte d'Ivoire"], ['Monrovia', null, 'Liberia'], ['Freetown', null, 'Sierra Leone'], ['Banjul', null, 'Gambia'],
  ['Malabo', null, 'Equatorial Guinea'], ['Libreville', null, 'Gabon'], ['Kinshasa', null, 'Congo'],
  ['Nairobi', null, 'Kenya'], ['Mombasa', null, 'Kenya'], ['Kampala', null, 'Uganda'], ['Kigali', null, 'Rwanda'],
  ['Dar es Salaam', null, 'Tanzania'], ['Addis Ababa', null, 'Ethiopia'], ['Johannesburg', 'Gauteng', 'South Africa'],
  ['Pretoria', 'Gauteng', 'South Africa'], ['Cape Town', 'Western Cape', 'South Africa'], ['Durban', 'KwaZulu-Natal', 'South Africa'],
  ['Lusaka', null, 'Zambia'], ['Harare', null, 'Zimbabwe'], ['Gaborone', null, 'Botswana'], ['Windhoek', null, 'Namibia'],
  ['Cairo', null, 'Egypt'], ['Casablanca', null, 'Morocco'], ['Rabat', null, 'Morocco'],
  ['Dubai', 'Dubai', 'United Arab Emirates'], ['Abu Dhabi', 'Abu Dhabi', 'United Arab Emirates'], ['Sharjah', 'Sharjah', 'United Arab Emirates'],
  ['Doha', null, 'Qatar'], ['Riyadh', null, 'Saudi Arabia'], ['Jeddah', null, 'Saudi Arabia'], ['Dammam', null, 'Saudi Arabia'],
  ['Kuwait City', null, 'Kuwait'], ['Muscat', null, 'Oman'], ['Manama', null, 'Bahrain'], ['Istanbul', null, 'Turkey'], ['Ankara', null, 'Turkey'],
  ['Berlin', null, 'Germany'], ['Hamburg', null, 'Germany'], ['Frankfurt', null, 'Germany'], ['Munich', null, 'Germany'], ['Cologne', null, 'Germany'],
  ['Paris', null, 'France'], ['Lyon', null, 'France'], ['Amsterdam', null, 'Netherlands'], ['Rotterdam', null, 'Netherlands'], ['The Hague', null, 'Netherlands'],
  ['Brussels', null, 'Belgium'], ['Antwerp', null, 'Belgium'], ['Rome', null, 'Italy'], ['Milan', null, 'Italy'], ['Turin', null, 'Italy'],
  ['Madrid', null, 'Spain'], ['Barcelona', null, 'Spain'], ['Lisbon', null, 'Portugal'], ['Zurich', null, 'Switzerland'], ['Geneva', null, 'Switzerland'],
  ['Vienna', null, 'Austria'], ['Stockholm', null, 'Sweden'], ['Oslo', null, 'Norway'], ['Copenhagen', null, 'Denmark'], ['Helsinki', null, 'Finland'],
  ['Warsaw', null, 'Poland'], ['Moscow', null, 'Russia'], ['Saint Petersburg', null, 'Russia'], ['Kyiv', null, 'Ukraine'], ['Kiev', null, 'Ukraine'],
  ['Nicosia', null, 'Cyprus'], ['Famagusta', null, 'Cyprus'], ['Kyrenia', null, 'Cyprus'], ['Athens', null, 'Greece'], ['Budapest', null, 'Hungary'],
  ['Beijing', null, 'China'], ['Shanghai', null, 'China'], ['Guangzhou', null, 'China'], ['Shenzhen', null, 'China'], ['Hong Kong', null, 'China'],
  ['Tokyo', null, 'Japan'], ['Seoul', null, 'South Korea'], ['Mumbai', null, 'India'], ['Delhi', null, 'India'], ['New Delhi', null, 'India'],
  ['Bangalore', null, 'India'], ['Chennai', null, 'India'], ['Hyderabad', null, 'India'], ['Karachi', null, 'Pakistan'], ['Lahore', null, 'Pakistan'],
  ['Kuala Lumpur', null, 'Malaysia'], ['Jakarta', null, 'Indonesia'], ['Manila', null, 'Philippines'], ['Bangkok', null, 'Thailand'],
  ['Sydney', 'New South Wales', 'Australia'], ['Melbourne', 'Victoria', 'Australia'], ['Brisbane', 'Queensland', 'Australia'],
  ['Perth', 'Western Australia', 'Australia'], ['Adelaide', 'South Australia', 'Australia'], ['Auckland', null, 'New Zealand'],
  ['Wellington', null, 'New Zealand'], ['Sao Paulo', null, 'Brazil'], ['Rio de Janeiro', null, 'Brazil'], ['Mexico City', null, 'Mexico'],
  ['Kingston', null, 'Jamaica'],
];

// Words that carry no place information.
const FILLER = new Set(['state', 'states', 'city', 'town', 'lga', 'local', 'government', 'govt', 'area', 'council',
  'the', 'of', 'in', 'at', 'near', 'from', 'metropolis', 'metro', 'district', 'province', 'county', 'capital',
  'territory', 'my', 'i', 'am', 'live', 'living', 'based', 'currently', 'and', 'or']);
// Answers that are clearly not a place.
const JUNK = new Set(['na', 'nil', 'none', 'null', 'nothing', 'no', 'home', 'house', 'myhouse', 'here', 'there', 'test',
  'abc', 'xyz', 'asdf', 'city', 'mycity', 'unknown', 'idk', 'nowhere', 'everywhere', 'earth', 'world', 'africa', 'westafrica']);

// ------------------------------------------------------------------ helpers
const squash = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const words = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);

// Restricted Damerau-Levenshtein, stopping early once past `max`.
function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d = [];
  for (let i = 0; i <= a.length; i++) { d[i] = [i]; }
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      rowMin = Math.min(rowMin, d[i][j]);
    }
    if (rowMin > max) return max + 1;
  }
  return d[a.length][b.length];
}
// How many typing slips a word of this length may carry and still count.
const allowedSlips = (len) => (len >= 9 ? 2 : len >= 5 ? 1 : 0);

// One spelling per place, so "Ogbomosho" and "Ogbomoso" count as one city.
const CANON = { 'Portharcourt': 'Port Harcourt', 'Port-Harcourt': 'Port Harcourt', 'Gwarimpa': 'Gwarinpa', 'Oshogbo': 'Osogbo',
  'Shagamu': 'Sagamu', 'Ilesha': 'Ilesa', 'Shaki': 'Saki', 'Ogbomosho': 'Ogbomoso', 'Ado Ekiti': 'Ado-Ekiti',
  'Ijebu Ode': 'Ijebu-Ode', 'Ile Ife': 'Ile-Ife', 'Benin': 'Benin City', 'Festac Town': 'Festac', 'Ilisan': 'Ilishan' };
const canon = (n) => CANON[n] || n;

// ------------------------------------------------------------------ index
// key -> list of entries { kind: 'state'|'lga'|'town'|'country'|'abroad', state, name, country, region }
const INDEX = new Map();
function add(key, entry) {
  if (!key) return;
  const list = INDEX.get(key) || [];
  if (!list.some(e => e.kind === entry.kind && e.state === entry.state && e.name === entry.name && e.country === entry.country)) list.push(entry);
  INDEX.set(key, list);
}
const DIRECTIONS = /\s+(north|south|east|west|central|north east|north west|south east|south west|municipal|metropolitan)$/i;

for (const state of Object.keys(LGAS)) {
  add(squash(state), { kind: 'state', state, name: stateLabel(state) });
  for (const a of STATE_ALIASES[state] || []) add(a, { kind: 'state', state, name: stateLabel(state) });
  for (const lga of LGAS[state]) {
    add(squash(lga), { kind: 'lga', state, name: lga });
    // "Ughelli North" is also simply "Ughelli"; "Obio/Akpor" also "Obio Akpor".
    const base = lga.replace(DIRECTIONS, '');
    if (base !== lga) add(squash(base), { kind: 'town', state, name: canon(base) });
    if (/[\/-]/.test(lga)) add(squash(lga.split(/[\/-]/)[0]), { kind: 'town', state, name: lga });
  }
  for (const t of TOWNS[state] || []) add(squash(t), { kind: 'town', state, name: canon(t) });
}
add('abujamunicipal', { kind: 'lga', state: 'FCT', name: 'Abuja Municipal Area Council' });
add('amac', { kind: 'lga', state: 'FCT', name: 'Abuja Municipal Area Council' });
for (const [country, keys] of Object.entries(COUNTRIES)) for (const k of keys) add(k, { kind: 'country', country, name: country });
for (const [name, region, country] of ABROAD) add(squash(name), { kind: 'abroad', name, region, country });
// A state name always wins over an LGA of the same name elsewhere (Kano has
// an LGA called "Nasarawa"; "Nasarawa" alone means the state).
for (const [key, list] of INDEX) {
  if (list.some(e => e.kind === 'state')) INDEX.set(key, list.filter(e => e.kind === 'state' || e.kind === 'country' || e.kind === 'abroad'));
}
const FUZZY_KEYS = [...INDEX.keys()].filter(k => k.length >= 5);

// ------------------------------------------------------------------ resolver
/**
 * @returns {{status:'matched'|'country_only'|'ambiguous'|'unmatched', country:string|null,
 *            state:string|null, city:string|null, method:string, key:string,
 *            candidates:Array<{state:string,name:string}>}}
 *   state = Nigerian state for Nigeria, or the region (Texas, Ontario...) abroad.
 */
function resolvePlace(raw) {
  const key = squash(raw);
  const out = (status, extra = {}) => ({ status, country: null, state: null, city: null, method: 'none', key, candidates: [], ...extra });
  if (!key || key.length < 2 || /^\d+$/.test(key) || JUNK.has(key)) return out('unmatched', { method: 'junk' });

  const whole = WHOLE_ANSWER_ONLY[key];
  if (whole) return out('matched', { country: 'Nigeria', state: whole.state, city: whole.city || null, method: 'short' });

  // Filler words stay in for matching ("Satellite Town", "Benin City") and
  // are only dropped when they are not part of a place name.
  const ws = words(raw);
  // Greedy longest match left to right, so "Katsina Ala" is the Benue town,
  // not the state of Katsina followed by a stray word.
  const hits = [];
  const leftover = [];
  for (let i = 0; i < ws.length;) {
    let found = null;
    for (let n = Math.min(4, ws.length - i); n >= 1; n--) {
      const k = ws.slice(i, i + n).join('');
      if (k.length < 2) continue;
      if (INDEX.has(k) && (k.length >= 3 || n > 1 || ws.length === 1)) { found = { n, k, entries: INDEX.get(k), text: ws.slice(i, i + n).join(' ') }; break; }
    }
    if (found) { hits.push(found); i += found.n; } else { if (!FILLER.has(ws[i])) leftover.push(ws[i]); i += 1; }
  }

  // Typing slips: only for words that matched nothing, and only when nothing
  // decisive was found exactly ("Ughell" in "Ughell, Delta State" still helps
  // name the town once Delta is known).
  const fuzzyHits = [];
  for (const w of leftover) {
    if (w.length < 5 || COUNTRIES.Nigeria.includes(w)) continue;
    const max = allowedSlips(w.length);
    let best = null, bestD = max + 1, tie = false;
    for (const k of FUZZY_KEYS) {
      if (Math.abs(k.length - w.length) > max) continue;
      const dd = editDistance(w, k, max);
      if (dd < bestD) { bestD = dd; best = k; tie = false; } else if (dd === bestD && dd <= max && best && INDEX.get(k)[0].state !== INDEX.get(best)[0].state) tie = true;
    }
    if (best && bestD <= max && !tie) fuzzyHits.push({ k: best, entries: INDEX.get(best), text: w, fuzzy: true });
  }

  const all = [...hits, ...fuzzyHits];
  const entries = all.flatMap(h => h.entries.map(e => ({ ...e, fuzzy: !!h.fuzzy })));
  const nigeriaNamed = entries.some(e => e.kind === 'country' && e.country === 'Nigeria');

  // ---- abroad
  const foreignCountries = [...new Set(entries.filter(e => e.kind === 'country' && e.country !== 'Nigeria').map(e => e.country))];
  const abroad = entries.filter(e => e.kind === 'abroad');
  const ngStates = [...new Set(entries.filter(e => e.kind === 'state').map(e => e.state))];
  if ((foreignCountries.length || abroad.length) && !ngStates.length) {
    const countries = [...new Set([...foreignCountries, ...abroad.map(a => a.country)])];
    if (countries.length === 1) {
      const city = abroad.find(a => a.country === countries[0] && !REGION_ONLY.has(a.name)) || null;
      const region = (abroad.find(a => a.country === countries[0]) || {}).region || null;
      return out('matched', { country: countries[0], state: region, city: city ? city.name : null, method: abroad.length ? 'abroad_city' : 'country' });
    }
    return out('ambiguous', { method: 'abroad_conflict', candidates: countries.map(c => ({ state: null, country: c, name: c })) });
  }

  // ---- Nigeria
  const places = entries.filter(e => e.kind === 'lga' || e.kind === 'town');
  const pickCity = (state) => {
    const inState = places.filter(p => p.state === state && squash(p.name) !== squash(state));
    if (!inState.length) return null;
    const town = inState.find(p => p.kind === 'town' && !p.fuzzy) || inState.find(p => p.kind === 'lga' && !p.fuzzy) || inState[0];
    return town.name;
  };

  // Each matched phrase gives the set of states it could be in.
  const placeGroups = all.map(h => [...new Set(h.entries.filter(e => e.kind === 'lga' || e.kind === 'town').map(e => e.state))]).filter(g => g.length);
  if (ngStates.length === 1) {
    // "Lekki, Lagos" agrees. "Abuja and Lagos" doesn't: a town is named and
    // none of the towns is in the named state.
    const s0 = ngStates[0];
    if (!placeGroups.length || placeGroups.some(g => g.includes(s0))) {
      return out('matched', { country: 'Nigeria', state: s0, city: pickCity(s0), method: 'state' });
    }
    const others = [...new Set(placeGroups.flat())];
    return out('ambiguous', { method: 'state_town_conflict', candidates: [s0, ...others].map(s => ({ state: s, name: stateLabel(s) })) });
  }
  if (ngStates.length > 1) {
    // "Abuja, Nasarawa" style: two states named. A town that belongs to just
    // one of them settles it; otherwise an admin decides.
    const both = places.filter(p => ngStates.includes(p.state));
    const placeStates = [...new Set(both.map(p => p.state))];
    if (placeStates.length === 1) return out('matched', { country: 'Nigeria', state: placeStates[0], city: pickCity(placeStates[0]), method: 'state+town' });
    return out('ambiguous', { method: 'two_states', candidates: ngStates.map(s => ({ state: s, name: stateLabel(s) })) });
  }
  if (places.length) {
    // Several names, one state they all share ("Ikotun Egbe": both Lagos).
    if (placeGroups.length > 1) {
      const shared = placeGroups.reduce((acc, g) => acc.filter(s => g.includes(s)));
      if (shared.length === 1) return out('matched', { country: 'Nigeria', state: shared[0], city: pickCity(shared[0]), method: 'towns_agree' });
    }
    const exact = places.filter(p => !p.fuzzy);
    const pool = exact.length ? exact : places;
    const states = [...new Set(pool.map(p => p.state))];
    if (states.length === 1) return out('matched', { country: 'Nigeria', state: states[0], city: pickCity(states[0]) || pool[0].name, method: exact.length ? 'town' : 'town_typo' });
    const seen = new Set();
    const candidates = pool.filter(p => !seen.has(p.state) && seen.add(p.state)).map(p => ({ state: p.state, name: `${p.name} (${stateLabel(p.state)})` }));
    return out('ambiguous', { method: 'shared_name', candidates });
  }
  if (nigeriaNamed) return out('country_only', { country: 'Nigeria', method: 'country' });
  return out('unmatched', { method: 'unknown' });
}

/** Closest known places, for the admin review screen. */
function suggestPlaces(raw, limit = 3) {
  const ws = words(raw).filter(w => !FILLER.has(w) && w.length >= 4);
  if (!ws.length) return [];
  const scored = new Map();
  for (const w of [...new Set([...ws, ws.join('')])]) {
    // Closer is required for shorter words, so "N/A" suggests nothing.
    const max = w.length >= 9 ? 2 : 1;
    for (const k of INDEX.keys()) {
      if (k.length < 4 || Math.abs(k.length - w.length) > max) continue;
      const dd = editDistance(w, k, max);
      if (dd > max) continue;
      for (const e of INDEX.get(k)) {
        const label = e.kind === 'abroad' ? `${e.name}, ${e.country}` : e.kind === 'country' ? e.country
          : e.kind === 'state' ? stateLabel(e.state) : `${e.name}, ${stateLabel(e.state)}`;
        const s = { label, state: e.state || e.region || null, country: e.country || 'Nigeria', city: (e.kind === 'town' || e.kind === 'lga' || e.kind === 'abroad') ? e.name : null, d: dd };
        if (!scored.has(label) || scored.get(label).d > dd) scored.set(label, s);
      }
    }
  }
  return [...scored.values()].sort((a, b) => a.d - b.d).slice(0, limit);
}

const NIGERIAN_STATES = Object.keys(LGAS).sort((a, b) => stateLabel(a).localeCompare(stateLabel(b)));

module.exports = { resolvePlace, suggestPlaces, squash, stateLabel, NIGERIAN_STATES, LGAS };
